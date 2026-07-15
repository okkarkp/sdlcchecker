# CloudFront Setup Guide

## Goal
- `https://your-domain.com/*`         → served from S3 (frontend)
- `https://your-domain.com/api/*`     → forwarded to EB/EC2 (backend)
- `https://your-domain.com/ws`        → forwarded to EB/EC2 (WebSocket)

## Steps

### 1. Create a CloudFront distribution
- **Origin 1 (S3)**  — Origin domain: `YOUR_BUCKET.s3-website-REGION.amazonaws.com`
- **Origin 2 (API)** — Origin domain: `YOUR_EB_URL.elasticbeanstalk.com`

### 2. Behaviours
| Path pattern | Origin | Cache policy           | Allowed methods |
|---|---|---|---|
| `/api/*`     | API    | CachingDisabled        | GET, HEAD, POST, PUT, DELETE, OPTIONS |
| `/socket.io/*` or `/ws` | API | CachingDisabled | GET, HEAD |
| `Default (*)`| S3     | CachingOptimized       | GET, HEAD |

### 3. Error pages
Add a custom error response:
- HTTP error code: 403 → Response page: `/index.html` → HTTP 200  
  _(allows SPA client-side routing to work)_

### 4. Environment variable to set on EB
```
ALLOWED_ORIGIN=https://YOUR_CLOUDFRONT_DOMAIN.cloudfront.net
```

### 5. WebSocket note
CloudFront supports WebSocket natively on HTTP/2 behaviours.
Make sure the `/ws` path behaviour has **HTTP/2 + WebSocket** enabled.
