# SadaHire CV Microservice - Render Deployment Guide

This guide provides step-by-step instructions for deploying the CV processing microservice on Render.

## Architecture Overview

This microservice runs as a **single web service** on Render that executes:
- **Express Server**: Handles file uploads via REST API (`/api/upload`)
- **BullMQ Worker**: Processes CV files from the Redis queue

Both processes run concurrently in the same container, sharing compute resources.

## Prerequisites

Before deploying, ensure you have:

1. **Upstash Redis Instance**: Get your Redis connection URL from [Upstash Console](https://console.upstash.com/)
   - The URL should be in TLS format: `rediss://default:password@endpoint:port`
   
2. **Flask CV Parser URL**: Your Flask service endpoint for CV parsing
   
3. **Main Backend URL**: Your main backend server endpoint

4. **GitHub Repository**: Your code pushed to a GitHub repository

## Deployment Steps

### Option 1: Deploy via Render Dashboard (Manual)

1. **Log in to Render**: Go to [https://dashboard.render.com/](https://dashboard.render.com/)

2. **Create New Web Service**:
   - Click "New +" → "Web Service"
   - Connect your GitHub repository
   - Select the repository containing this microservice

3. **Configure Service**:
   - **Name**: `sadahire-cv-microservice` (or your preferred name)
   - **Region**: Choose closest to your users
   - **Branch**: `main` or `master`
   - **Runtime**: Node
   - **Build Command**: `npm install && npm run build`
   - **Start Command**: `npm start`
   - **Instance Type**: Starter (or higher based on load)

4. **Add Environment Variables**:
   Go to the "Environment" tab and add:

   **Required Variables**:
   ```
   REDIS_URL=rediss://default:your-password@your-upstash-endpoint.upstash.io:6379
   FLASK_PARSER_URL=https://your-flask-service.com/api/cv-to-json
   MAIN_SERVER_URL=https://your-main-backend.com
   ```

   **Storage Configuration** (for local storage):
   ```
   UPLOAD_STORAGE_TYPE=local
   LOCAL_UPLOAD_PATH=uploads
   ```

   **Optional Variables**:
   ```
   NODE_ENV=production
   WORKER_DELAY_MS=10000
   ```

   **S3 Variables** (for future use when migrating to S3):
   ```
   AWS_REGION=us-east-1
   AWS_ACCESS_KEY_ID=your-access-key
   AWS_SECRET_ACCESS_KEY=your-secret-key
   S3_BUCKET_NAME=your-bucket-name
   ```

5. **Configure Health Check**:
   - Path: `/health`
   - This endpoint returns `{"ok": true}` when the service is running

6. **Deploy**: Click "Create Web Service"
   - Render will automatically build and deploy your service
   - First deployment takes 3-5 minutes

### Option 2: Deploy via render.yaml (Infrastructure as Code)

1. **Push render.yaml**: The `render.yaml` file is already configured in the repository root

2. **Create Blueprint**:
   - In Render Dashboard, go to "Blueprints"
   - Click "New Blueprint Instance"
   - Connect your repository
   - Render will detect `render.yaml` automatically

3. **Set Secret Environment Variables**:
   The render.yaml marks certain variables as `sync: false`, meaning you need to set them manually:
   - `REDIS_URL`
   - `FLASK_PARSER_URL`
   - `MAIN_SERVER_URL`
   - S3 credentials (optional)

4. **Apply Blueprint**: Render will create the service based on your configuration

## Post-Deployment

### Verify Deployment

1. **Check Service Status**:
   - Go to your service in Render Dashboard
   - Status should show "Live" with a green indicator

2. **Test Health Endpoint**:
   ```bash
   curl https://your-service-url.onrender.com/health
   ```
   Should return: `{"ok": true}`

3. **Check Logs**:
   - Go to "Logs" tab in Render Dashboard
   - You should see both server and worker startup messages:
   ```
   CV microservice listening on 10000
   Worker shutting down...
   ```

### Monitor Logs

Render provides real-time logs accessible via:
- **Dashboard**: Service → Logs tab
- **CLI**: Install Render CLI and use `render logs`

Look for:
- **Server logs**: HTTP requests, file uploads
- **Worker logs**: CV processing, success/failure messages, statistics

### Test Upload Endpoint

```bash
curl -X POST https://your-service-url.onrender.com/api/upload \
  -F "files=@cv1.pdf" \
  -F "files=@cv2.pdf" \
  -F "userId=test-user" \
  -F "jobId=job-123" \
  -F "sessionToken=your-session-token"
```

Expected response:
```json
{
  "success": true,
  "message": "2 files accepted",
  "batchId": "batch_1234567890_1234"
}
```

## Important Considerations

### ⚠️ Local Storage Limitations

**Current Setup**: Files are stored locally on Render's ephemeral filesystem

**Implications**:
- ✅ Works for current low-scale usage
- ⚠️ Files are **deleted** when service restarts or redeploys
- ⚠️ Files are **not shared** if you scale to multiple instances
- ⚠️ Limited disk space (10GB on Starter plan)

**Recommendation**: 
- For production at scale, migrate to S3 by setting `UPLOAD_STORAGE_TYPE=s3` and configuring AWS credentials
- The codebase already supports S3, just update environment variables

### Performance Notes

- **Shared Resources**: Server and worker run on the same instance
- **Worker Delay**: Default 10s delay between CV processing (configurable via `WORKER_DELAY_MS`)
- **Concurrency**: Single worker processes one CV at a time
- **Scaling**: To increase throughput, deploy worker as a separate Background Worker service

### Redis Connection

- **Upstash Redis**: Uses TLS by default (rediss://)
- **Connection String Format**: `rediss://default:password@endpoint:port`
- **Timeout**: Ensure Upstash allows connections from Render's IP ranges (usually automatic)

### Auto-Deploy

Render automatically redeploys when you push to your connected branch:
- **Main/Master branch**: Auto-deploy on every push
- **Other branches**: Manual deploy only

## Troubleshooting

### Service Won't Start

1. Check environment variables are set correctly
2. Verify Redis connection string format (must use `rediss://` for TLS)
3. Check build logs for compilation errors

### Worker Not Processing

1. Check Redis connection in logs
2. Verify queue name is `cv-processing` (defined in `queue.ts`)
3. Ensure worker has access to Flask and Main Server URLs

### Health Check Failing

1. Verify port is not hardcoded (use `process.env.PORT`)
2. Render assigns port dynamically (usually 10000)
3. Check server startup logs

### Out of Disk Space

1. Monitor disk usage in Render Dashboard
2. Consider migrating to S3 storage
3. Upgrade to plan with more disk space

## Migrating to S3 (Future)

When ready to scale:

1. **Set up AWS S3**:
   - Create S3 bucket
   - Create IAM user with S3 read/write permissions
   - Get access key and secret

2. **Update Environment Variables**:
   ```
   UPLOAD_STORAGE_TYPE=s3
   AWS_REGION=us-east-1
   AWS_ACCESS_KEY_ID=your-key
   AWS_SECRET_ACCESS_KEY=your-secret
   S3_BUCKET_NAME=your-bucket
   ```

3. **Redeploy**: Service will automatically use S3 for file storage

## Scaling Options

When you need more throughput:

1. **Vertical Scaling**: Upgrade instance type in Render
2. **Horizontal Scaling**: Deploy worker as separate Background Worker service
3. **Multiple Workers**: Run multiple worker instances (requires separate service)

## Support

- **Render Docs**: [https://render.com/docs](https://render.com/docs)
- **Upstash Docs**: [https://docs.upstash.com/redis](https://docs.upstash.com/redis)
- **BullMQ Docs**: [https://docs.bullmq.io/](https://docs.bullmq.io/)

## Estimated Costs

- **Render Starter**: $7/month (includes 512MB RAM, 0.5 CPU)
- **Upstash Redis**: Free tier (10,000 commands/day) or paid plans
- **S3 Storage** (future): ~$0.023/GB + transfer costs

---

**Ready to Deploy?** Follow the steps above and your CV microservice will be live in minutes! 🚀

