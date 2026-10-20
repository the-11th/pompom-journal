FROM python:3.12-slim
WORKDIR /app
RUN pip install --no-cache-dir flask==3.1.0 waitress==3.0.2 cryptography==50.0.1
COPY integrations/ integrations/
COPY journal_media.py todo.py ./
RUN useradd --create-home todopup && mkdir /data && chown todopup /data
USER todopup
ENV PORT=8080 TODOPUP_INBOX_DATA=/data
EXPOSE 8080
VOLUME ["/data"]
CMD ["python", "-m", "integrations.discord_receiver"]
