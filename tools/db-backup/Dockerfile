# Image pg-backup: pg_dump/pg_restore 17 + aws-cli (unggah backup ke Cloudflare R2) + zona waktu WIB.
FROM postgres:17-alpine

RUN apk add --no-cache bash aws-cli tzdata

COPY db-backup.sh /scripts/db-backup.sh
RUN chmod +x /scripts/db-backup.sh

ENTRYPOINT ["/scripts/db-backup.sh"]
CMD ["loop"]
