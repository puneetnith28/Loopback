#!/bin/sh
# Compose the role's squid configuration in /tmp (the root filesystem is read-only) and run squid
# in the foreground. LOOPBACK_PROXY_ROLE=fixer|verifier|signer is required. The fixer's npm
# registry access is off unless LOOPBACK_FIXER_REGISTRY=1; the verifier never gets it. The signer
# (D29) gets only api.github.com, to read the PR's live head.
set -eu
role="${LOOPBACK_PROXY_ROLE:-}"
case "$role" in fixer|verifier|signer) ;; *) echo "loopback-proxy: LOOPBACK_PROXY_ROLE must be fixer, verifier or signer" >&2; exit 2 ;; esac
conf=/tmp/squid.conf
cp /etc/loopback-proxy/squid.conf "$conf"
{
  if [ "$role" = signer ]; then
    echo "http_access allow github_api"
  else
    echo "http_access allow github"
    echo "http_access allow model"
    if [ "$role" = fixer ] && [ "${LOOPBACK_FIXER_REGISTRY:-0}" = "1" ]; then
      echo "http_access allow registry"
    fi
  fi
  echo "http_access deny all"
} >>"$conf"
squid -k parse -f "$conf"
exec squid -N -f "$conf"
