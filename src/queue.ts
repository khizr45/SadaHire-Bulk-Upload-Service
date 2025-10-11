// src/queue.ts
import { Queue } from "bullmq";
import IORedis from "ioredis";
import dotenv from "dotenv";
dotenv.config();

const connection = new IORedis(process.env.REDIS_URL || "127.0.0.1:6379");

export const cvQueue = new Queue("cv-processing", { connection });
