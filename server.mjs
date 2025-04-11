import express from "express";
import multer from "multer";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import cors from "cors";

const execPromise = promisify(exec);

const app = express();
const TEMP_DIR = "temp/";
const OUTPUT_DIR = "latex_files/";
const ALLOWED_ORIGIN = "https://latex-extr.netlify.app/";

app.use(
  cors({
    origin: ALLOWED_ORIGIN,
    methods: ["POST"],
    allowedHeaders: ["Content-Type"],
  })
);
app.use(express.json());

const upload = multer({ dest: TEMP_DIR });

async function ensureDirectories() {
  await Promise.all([
    fs.mkdir(TEMP_DIR, { recursive: true }),
    fs.mkdir(OUTPUT_DIR, { recursive: true }),
  ]);
}

async function convertWordToLatex(wordFile, latexFile) {
  const command = `pandoc "${wordFile}" -o "${latexFile}" --to=latex`;
  const { stderr } = await execPromise(command);
  if (stderr && stderr.includes("error")) {
    throw new Error(`Failed to convert ${wordFile} to LaTeX: ${stderr}`);
  }
}

function extractMathExpressions(latexContent) {
  const patterns = [
    /\\\(.*?\\\)/g,
    /\\\[(.*?)\\\]/gs,
    /\$(.*?)\$/g,
    /\\begin{equation}(.*?)\\end{equation}/gs,
    /\\begin{align}(.*?)\\end{align}/gs,
    /\\begin{multline}(.*?)\\end{multline}/gs,
  ];

  const mathExpressions = [];
  for (const pattern of patterns) {
    const matches = [...latexContent.matchAll(pattern)];
    matches.forEach((match) => {
      if (match[1]) mathExpressions.push(match[1]);
      else if (match[0]) mathExpressions.push(match[0]);
    });
  }
  return mathExpressions;
}

function cleanLatexSyntax(latexExpression) {
  return latexExpression
    .replace(/%.*$/gm, "")
    .replace(/\\(label|nonumber|tag|qquad|quad|vspace|hspace){[^}]*}/g, "")
    .replace(/^\s*[\r\n]/gm, "")
    .trim();
}

class FileHandler {
  constructor(file) {
    if (!file || !file.path || !file.originalname) {
      throw new Error("Invalid file upload data");
    }
    this.fileName = path.basename(
      file.originalname,
      path.extname(file.originalname)
    );
    this.tempPath = file.path;
    this.latexPath = path.join(TEMP_DIR, `${this.fileName}_bulk.txt`);
    this.outputPath = path.join(OUTPUT_DIR, `${this.fileName}.txt`);
  }

  async processFile() {
    await convertWordToLatex(this.tempPath, this.latexPath);
    const latexContent = await this.readLatexFile();
    const mathExpressions = extractMathExpressions(latexContent);
    const cleanedExpressions = mathExpressions.map(cleanLatexSyntax);
    await this.writeOutputFile(cleanedExpressions);
    return this.outputPath;
  }

  async readLatexFile() {
    return await fs.readFile(this.latexPath, "utf-8");
  }

  async writeOutputFile(mathExpressions) {
    const content = mathExpressions
      .map((expr) => expr.replace(/\\/g, "\\\\").trim())
      .join("\n\n");
    await fs.writeFile(this.outputPath, content);
  }

  getCleanupFiles() {
    return [this.tempPath, this.latexPath, this.outputPath];
  }

  getFileName() {
    return this.fileName;
  }
}

async function cleanupFiles(files) {
  await Promise.all(
    files.map((file) =>
      fs.unlink(file).catch((err) => {
        if (err.code !== "ENOENT")
          console.error(`Failed to delete ${file}: ${err}`);
      })
    )
  );
}

function sendFileResponse(res, filePath, fileName) {
  res.set({
    "Content-Type": "text/plain",
    "Content-Disposition": `attachment; filename="${fileName}.txt"`,
  });
  res.sendFile(filePath, { root: "." });
}

app.post("/convert", upload.single("file"), async (req, res) => {
  console.log("Received POST request");
  if (req.method !== "POST") {
    return res.status(405).send("Method Not Allowed");
  }

  let handler;
  try {
    await ensureDirectories();

    if (!req.file) {
      throw new Error("No file uploaded. Please select a file.");
    }

    handler = new FileHandler(req.file);
    const outputFile = await handler.processFile();

    sendFileResponse(res, outputFile, handler.getFileName());

    res.on("finish", () => cleanupFiles(handler.getCleanupFiles()));
  } catch (error) {
    console.error(error);
    res.status(500).send(`Error: ${error.message}`);
    if (handler) {
      await cleanupFiles(handler.getCleanupFiles());
    }
  }
});

app.get("/convert", (req, res) => {
  console.log("Received GET request");
  res.send("Server is running");
});

const PORT = process.env.PORT || 3000;
console.log(PORT);
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
