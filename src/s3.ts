// src/s3.ts
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import fs from "fs";
import streamToArray from "stream-to-array";
import path from "path";
import dotenv from "dotenv";
dotenv.config();

const s3Client = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || "",
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || ""
  }
});

/**
 * Uploads a local file to S3 under given key
 */
export async function uploadFileToS3(localPath: string, key: string) {
  const stream = fs.createReadStream(localPath);
  await s3Client.send(new PutObjectCommand({
    Bucket: process.env.S3_BUCKET_NAME!,
    Key: key,
    Body: stream
  }));
}

/**
 * Downloads S3 object (s3://bucket/key) to a temp local path and returns the path
 */
export async function downloadFileFromS3(s3Path: string): Promise<string> {
  // s3Path format: s3://bucket/key...
  const parts = s3Path.replace("s3://", "").split("/");
  const bucket = parts.shift()!;
  const key = parts.join("/");

  const resp = await s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const body = resp.Body;
  if (!body) throw new Error("No body from S3");

  const chunks = await streamToArray(body as any);
  const filename = path.basename(key);
  const tmpPath = path.join("/tmp", `${Date.now()}_${filename}`);
  fs.writeFileSync(tmpPath, Buffer.concat(chunks));
  return tmpPath;
}
