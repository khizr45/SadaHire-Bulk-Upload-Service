// src/server.ts
import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import dotenv from "dotenv";
import { cvQueue } from "./queue";
import { uploadFileToS3 } from "./s3";
import cors from "cors";

dotenv.config();

const app = express();
app.use(express.json());
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));


const UPLOAD_TYPE = process.env.UPLOAD_STORAGE_TYPE || "local";
const LOCAL_UPLOAD_PATH = process.env.LOCAL_UPLOAD_PATH || "uploads";
const uploadDir = path.resolve(process.cwd(), LOCAL_UPLOAD_PATH);

if (UPLOAD_TYPE === "local" && !fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

// Multer: store to uploads (local) or /tmp then move to S3
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_TYPE === "local" ? uploadDir : "/tmp"),
  filename: (req, file, cb) => cb(null, `${Date.now()}__${file.originalname}`)
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } }); // 50MB per file

/**
 * POST /api/upload
 * multipart/form-data: files[], userId
 * returns { success, batchId }
 */
app.post("/api/upload", upload.array("files"), async (req, res) => {
  const files = req.files as Express.Multer.File[] | undefined;
  const userId = req.body.userId || null;

  if (!files || files.length === 0) return res.status(400).json({ error: "No files uploaded" });
  
  // Validate required jobId field
  if (!req.body.jobId) {
    return res.status(400).json({ error: "jobId is required in the request body" });
  }

  const batchId = `batch_${Date.now()}_${Math.floor(Math.random() * 10000)}`;

  try {
    const totalFiles = files.length; // Track total files in batch
    
    for (const file of files) {
      let filePath = file.path; // local path

      if (UPLOAD_TYPE === "s3") {
        const s3Key = `${batchId}/${file.originalname}`;
        await uploadFileToS3(file.path, s3Key);
        filePath = `s3://${process.env.S3_BUCKET_NAME}/${s3Key}`;
        // remove local temp after upload
        try { fs.unlinkSync(file.path); } catch (e) { /* ignore */ }
      }

      // enqueue job per CV
      await cvQueue.add("process-cv", {
        batchId,
        userId,
        originalName: file.originalname,
        jobId: req.body.jobId,
        location: req.body.location,
        sessionToken: req.body.sessionToken,
        filePath, // local path or s3://...
        totalFilesInBatch: totalFiles // Pass total count
      }, {
        attempts: 3,
        backoff: { type: "exponential", delay: 2000 }
      });
    }

    return res.json({ success: true, message: `${files.length} files accepted`, batchId });
  } catch (err: any) {
    console.error("Upload error", err);
    return res.status(500).json({ error: "Upload failed" });
  }
});

// health
app.get("/health", (_req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 5001;
const server = app.listen(PORT, () => console.log(`CV microservice listening on ${PORT}`));

// graceful shutdown
const shutdown = async () => {
  console.log("Shutting down server...");
  server.close(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
