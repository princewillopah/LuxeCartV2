FROM python:3.11-slim

WORKDIR /app

RUN apt-get update && apt-get install -y gcc && rm -rf /var/lib/apt/lists/*

COPY services/recommendation-service/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY services/recommendation-service/ .

EXPOSE 3014

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "3014"]
