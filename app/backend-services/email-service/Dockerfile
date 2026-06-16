FROM python:3.11-slim

WORKDIR /app

RUN apt-get update && apt-get install -y gcc && rm -rf /var/lib/apt/lists/*

COPY backend-services/email-service/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY backend-services/email-service/ ./
COPY backend-services/shared/shared_logger.py ./shared_logger.py

# Health check — stdlib urllib only (no extra runtime dep). Same
# contract as the other Python services: 2xx from /health = healthy.
# k8s readinessProbe should hit the same /health endpoint.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if 200<=urllib.request.urlopen('http://localhost:3015/health',timeout=2).status<300 else 1)" || exit 1

EXPOSE 3015

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "3015"]
