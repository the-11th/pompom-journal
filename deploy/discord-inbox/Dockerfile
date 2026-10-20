FROM python:3.12-slim
WORKDIR /app
RUN pip install --no-cache-dir flask==3.1.0 waitress==3.0.2 cryptography==50.0.1
COPY datapom/ datapom/
RUN useradd --create-home datapom && mkdir /data && chown datapom /data
USER datapom
# The application defaults to /data; leave its override unset so legacy
# TODOPUP_INBOX_DATA deployments remain compatible with DATAPOM_INBOX_DATA.
ENV PORT=8080
EXPOSE 8080
VOLUME ["/data"]
CMD ["python", "-m", "datapom.integrations.discord_receiver"]
