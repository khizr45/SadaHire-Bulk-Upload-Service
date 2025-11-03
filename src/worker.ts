import { Worker, Job } from "bullmq";
import IORedis from "ioredis";
import fs from "fs";
import path from "path";
import axios from "axios";
import FormData from "form-data";
import dotenv from "dotenv";
import { downloadFileFromS3 } from "./s3";

dotenv.config();

const connection = new IORedis(process.env.REDIS_URL || "redis://127.0.0.1:6379");
const WORKER_DELAY_MS = Number(process.env.WORKER_DELAY_MS || 10000);

// Upload Statistics Tracking (Global)
const uploadStats = {
  total: 0,
  success: 0,
  failed: 0,
  alreadyApplied: 0,
  failedFiles: [] as string[],
  alreadyAppliedFiles: [] as string[]
};

// Batch-specific tracking
interface BatchStats {
  batchId: string;
  totalFiles: number;
  successCount: number;
  failedCount: number;
  alreadyAppliedCount: number;
  failedFiles: string[];
  alreadyAppliedFiles: string[];
  sessionToken?: string;
  userId?: string | null;
}

const batchTracking = new Map<string, BatchStats>();

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function logStats() {
  console.log("\n📊 Upload Statistics:");
  console.log(`   Total Uploads: ${uploadStats.total}`);
  console.log(`   Successful: ${uploadStats.success}`);
  console.log(`   Already Applied (403): ${uploadStats.alreadyApplied}`);
  console.log(`   Failed: ${uploadStats.failed}`);
  if (uploadStats.alreadyAppliedFiles.length > 0) {
    console.log(`   Already Applied Files:`);
    uploadStats.alreadyAppliedFiles.forEach((file, idx) => {
      console.log(`     ${idx + 1}. ${file}`);
    });
  }
  if (uploadStats.failedFiles.length > 0) {
    console.log(`   Failed Files:`);
    uploadStats.failedFiles.forEach((file, idx) => {
      console.log(`     ${idx + 1}. ${file}`);
    });
  }
  console.log("");
}

async function sendBulkUploadReport(batchStats: BatchStats) {
  try {
    const mainUrl = (process.env.MAIN_SERVER_URL || "http://localhost:5000").replace(/\/$/, "");
    const reportUrl = `${mainUrl}/api/report/send-bulk-upload-report`;

    const payload = {
      totalUploaded: batchStats.totalFiles,
      successCount: batchStats.successCount,
      failedCount: batchStats.failedCount,
      alreadyAppliedCount: batchStats.alreadyAppliedCount,
      failedFiles: batchStats.failedFiles,
      alreadyAppliedFiles: batchStats.alreadyAppliedFiles,
    };

    console.log(`\n📧 Sending bulk upload report for batch ${batchStats.batchId}...`);
    
    const response = await axios.post(reportUrl, payload, {
      headers: {
        "Content-Type": "application/json",
        Authorization: `${batchStats.sessionToken || ""}`
      },
      timeout: 30000
    });

    if (response.data) {
      console.log(`✅ Report sent successfully for batch ${batchStats.batchId}`);
    }
  } catch (error: any) {
    console.error(`❌ Failed to send report for batch ${batchStats.batchId}:`, error.message);
  }
}

function initializeBatch(batchId: string, totalFiles: number, sessionToken?: string, userId?: string | null) {
  if (!batchTracking.has(batchId)) {
    batchTracking.set(batchId, {
      batchId,
      totalFiles: totalFiles, // Set the total upfront
      successCount: 0,
      failedCount: 0,
      alreadyAppliedCount: 0,
      failedFiles: [],
      alreadyAppliedFiles: [],
      sessionToken,
      userId
    });
  }
  return batchTracking.get(batchId)!;
}

async function checkAndSendReport(batchId: string) {
  const batch = batchTracking.get(batchId);
  if (!batch) return;

  const completedCount = batch.successCount + batch.failedCount + batch.alreadyAppliedCount;
  
  if (completedCount === batch.totalFiles) {
    console.log(`\n✨ Batch ${batchId} completed: ${batch.successCount} success, ${batch.alreadyAppliedCount} already applied, ${batch.failedCount} failed`);
    await sendBulkUploadReport(batch);
    batchTracking.delete(batchId); // Clean up
  }
}

const worker = new Worker("cv-processing", async (job: Job) => {
  const data = job.data as {
    batchId: string;
    userId?: string | null;
    originalName: string;
    filePath: string; // local path or s3://...
    jobId: string; // Added: job id for main backend
    location?: string; // optional, for candidate data
    sessionToken?: string; // optional backend token
    totalFilesInBatch: number; // Total number of files in this batch
  };

  // Initialize batch tracking
  initializeBatch(data.batchId, data.totalFilesInBatch, data.sessionToken, data.userId);

  let localFile = data.filePath;

  try {
    // 1️⃣ Download from S3 if needed
    if (typeof localFile === "string" && localFile.startsWith("s3://")) {
      localFile = await downloadFileFromS3(localFile);
    }

    if (!fs.existsSync(localFile)) throw new Error(`File not found: ${localFile}`);

    // 2️⃣ Send PDF to Flask CV-to-JSON
    const form = new FormData();
    form.append("file", fs.createReadStream(localFile), data.originalName);

    const flaskUrl = (process.env.FLASK_PARSER_URL || "http://localhost:8001/api/cv-to-json").replace(/\/$/, "");
    if (data.location) form.append("location", data.location);

    const parserResp = await axios.post(`${flaskUrl}`, form, {
      headers: form.getHeaders(),
      timeout: 120000
    });

    const candidateData = parserResp.data;

    // 3️⃣ Wrap original file + candidateData for main backend
    const mainForm = new FormData();
    mainForm.append("file", fs.createReadStream(localFile), data.originalName);
    mainForm.append("candidateData", JSON.stringify({ ...candidateData, location: data.location }));

    const mainUrl = (process.env.MAIN_SERVER_URL || "http://localhost:5000").replace(/\/$/, "");
    const applyUrl = `${mainUrl}/api/candidate/apply/${data.jobId}`;

    let alreadyApplied = false;

    try {
      const mainResp = await axios.post(applyUrl, mainForm, {
        headers: {
          Authorization: `${data.sessionToken || ""}`,
          ...mainForm.getHeaders()
        },
        timeout: 30000
      });

      if (!mainResp.data.status) {
        throw new Error("Error applying CV to main backend");
      }
    } catch (mainErr: any) {
      // Handle 403 - Already Applied
      if (mainErr.response && mainErr.response.status === 403) {
        console.log(`⚠️  CV ${data.originalName} already applied (403)`);
        alreadyApplied = true;
      } else {
        // Re-throw other errors
        throw mainErr;
      }
    }

    // 4️⃣ Cleanup local file
    if (!job.data.filePath.startsWith("s3://")) {
      try { fs.unlinkSync(localFile); } catch {}
    } else {
      try { fs.unlinkSync(localFile); } catch {}
    }

    // 5️⃣ Wait 10 seconds before next CV
    await sleep(WORKER_DELAY_MS);

    return { ok: true, alreadyApplied };

  } catch (err: any) {
    console.error(`Job ${job.id} failed for ${data.originalName}:`, err.message || err);
    // cleanup on error
    try { fs.existsSync(localFile) && fs.unlinkSync(localFile); } catch {}
    throw err; // let BullMQ handle retry
  }
}, { connection });

worker.on("completed", async (job) => {
  const batchId = job.data.batchId;
  const fileName = job.data.originalName;
  const returnValue = job.returnvalue as { ok: boolean; alreadyApplied?: boolean } | undefined;
  
  // Check if this was an "already applied" case
  const wasAlreadyApplied = returnValue?.alreadyApplied === true;
  
  // Update global stats
  uploadStats.total++;
  if (wasAlreadyApplied) {
    uploadStats.alreadyApplied++;
    uploadStats.alreadyAppliedFiles.push(fileName);
  } else {
    uploadStats.success++;
  }
  
  // Update batch stats
  const batch = batchTracking.get(batchId);
  if (batch) {
    if (wasAlreadyApplied) {
      batch.alreadyAppliedCount++;
      batch.alreadyAppliedFiles.push(fileName);
    } else {
      batch.successCount++;
    }
  }
  
  if (wasAlreadyApplied) {
    console.log(`⚠️  Already Applied CV ${fileName}`);
  } else {
    console.log(`✅ Completed CV ${fileName}`);
  }
  logStats();
  
  // Check if batch is complete and send report
  await checkAndSendReport(batchId);
  
  // Remove job from Redis to free up memory
  await job.remove();
});

worker.on("failed", async (job, err) => {
  const batchId = job?.data.batchId;
  const fileName = job?.data.originalName || "Unknown file";
  
  // Update global stats
  uploadStats.total++;
  uploadStats.failed++;
  uploadStats.failedFiles.push(fileName);
  
  // Update batch stats
  if (batchId) {
    const batch = batchTracking.get(batchId);
    if (batch) {
      batch.failedCount++;
      batch.failedFiles.push(fileName);
    }
  }
  
  console.error(`❌ Failed CV ${fileName}:`, err?.message);
  logStats();
  
  // Check if batch is complete and send report
  if (batchId) {
    await checkAndSendReport(batchId);
  }
  
  // Remove failed job from Redis after max retries to free up memory
  if (job && job.attemptsMade >= (job.opts.attempts || 3)) {
    await job.remove();
  }
});

// Periodic cleanup of old completed and failed jobs
const cleanupInterval = setInterval(async () => {
  try {
    const { Queue } = await import("bullmq");
    const cleanQueue = new Queue("cv-processing", { connection });
    
    // Clean completed jobs older than 1 hour
    await cleanQueue.clean(3600 * 1000, 100, "completed");
    
    // Clean failed jobs older than 24 hours
    await cleanQueue.clean(24 * 3600 * 1000, 200, "failed");
    
    console.log("🧹 Redis cleanup completed");
  } catch (err) {
    console.error("Cleanup error:", err);
  }
}, 30 * 60 * 1000); // Run every 30 minutes

const shutdown = async () => {
  console.log("Worker shutting down...");
  console.log("\n🏁 Final Upload Statistics:");
  logStats();
  clearInterval(cleanupInterval);
  await worker.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
