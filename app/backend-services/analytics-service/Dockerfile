FROM python:3.11-slim

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y \
    gcc \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements
COPY backend-services/analytics-service/requirements.txt .

# Install dependencies
RUN pip install --no-cache-dir -r requirements.txt

# Copy application
COPY backend-services/analytics-service/ ./
COPY backend-services/shared/shared_logger.py ./shared_logger.py

# Health check — uses stdlib urllib (no extra runtime dep). Treats any
# 2xx response from FastAPI's /health as healthy; non-2xx or exception
# exits 1, which Docker reports as 'unhealthy' and k8s readinessProbe
# can wire to the same /health endpoint.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if 200<=urllib.request.urlopen('http://localhost:3013/health',timeout=2).status<300 else 1)" || exit 1

EXPOSE 3013

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "3013"]
