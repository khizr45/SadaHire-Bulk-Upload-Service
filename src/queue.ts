// src/queue.ts
import { Queue } from "bullmq";
import IORedis from "ioredis";
import dotenv from "dotenv";
dotenv.config();

const connection = new IORedis(process.env.REDIS_URL || "127.0.0.1:6379");

export const cvQueue = new Queue("cv-processing", { 
  connection,
  defaultJobOptions: {
    removeOnComplete: {
      age: 3600, // Keep completed jobs for 1 hour (3600 seconds)
      count: 100, // Keep last 100 completed jobs
    },
    removeOnFail: {
      age: 86400, // Keep failed jobs for 24 hours (86400 seconds) for debugging
      count: 200, // Keep last 200 failed jobs
    },
  },
});
