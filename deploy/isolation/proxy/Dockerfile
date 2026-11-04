# Allowlisting egress proxy for the fixer and verifier containers (D19, D28). HTTPS only (CONNECT
# to port 443), named domains only, private/link-local/metadata destinations refused even when an
# allowed name resolves to them. Runs as the unprivileged `proxy` user with a read-only root.
FROM debian:bookworm-slim@sha256:99c0b25c46d0214d5a2091092e7908907dcaecd6a962cde0ac700acee222b6f3
RUN apt-get update && apt-get install -y --no-install-recommends squid \
    && rm -rf /var/lib/apt/lists/*
# Plain COPY + chmod: works with or without BuildKit.
COPY squid.conf allow-github.txt allow-github-api.txt allow-model.txt allow-registry.txt /etc/loopback-proxy/
COPY entrypoint.sh /usr/local/bin/loopback-proxy
RUN chown -R root:root /etc/loopback-proxy /usr/local/bin/loopback-proxy \
    && chmod 0755 /etc/loopback-proxy /usr/local/bin/loopback-proxy \
    && chmod 0644 /etc/loopback-proxy/*
USER proxy
EXPOSE 3128
ENTRYPOINT ["/usr/local/bin/loopback-proxy"]
