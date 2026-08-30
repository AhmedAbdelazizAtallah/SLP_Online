FROM python:3.11-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir --upgrade pip && pip install --no-cache-dir -r requirements.txt
COPY app.html app.compiled.js manifest.json sw.js Server.py arsl_model.tflite asl_model.tflite ./
COPY vendor ./vendor
COPY icons ./icons
ENV PORT=8000
EXPOSE 8000
CMD ["sh", "-c", "uvicorn Server:app --host 0.0.0.0 --port ${PORT}"]
