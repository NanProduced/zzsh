#!/usr/bin/env bash
set -euo pipefail
umask 077

if [[ ${EUID} -ne 0 || $# -ne 1 || $1 != /* ]]; then
  echo 'Run as root with one absolute, empty secrets directory outside the checkout.' >&2
  exit 2
fi
command -v openssl >/dev/null
command -v sha256sum >/dev/null
target=$(realpath -m -- "$1")
repo=$(realpath -- "$(dirname -- "${BASH_SOURCE[0]}")/../..")
if [[ $target == / || $target == "$repo" || $target == "$repo/"* ]]; then
  echo 'Secrets must be outside the repository.' >&2
  exit 2
fi
if [[ -e $target ]] && [[ -n $(find "$target" -mindepth 1 -maxdepth 1 -print -quit) ]]; then
  echo 'Secrets directory is not empty; refusing to replace existing keys.' >&2
  exit 2
fi

install -d -o root -g root -m 0700 "$target" "$target/postgres" "$target/redis" "$target/ca-private"
install -d -o root -g root -m 0755 "$target/tls"
install -d -o root -g 1000 -m 0750 "$target/api" "$target/migration"

openssl req -x509 -newkey rsa:3072 -sha256 -nodes -days 1825 -subj '/CN=ZZSH Internal Test CA' \
  -keyout "$target/ca-private/ca.key" -out "$target/tls/internal-ca.crt" >/dev/null 2>&1
for service in postgres redis; do
  openssl req -new -newkey rsa:2048 -sha256 -nodes -subj "/CN=$service" \
    -keyout "$target/tls/$service.key" -out "$target/ca-private/$service.csr" >/dev/null 2>&1
  printf 'subjectAltName=DNS:%s\nextendedKeyUsage=serverAuth\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\n' "$service" > "$target/ca-private/$service.ext"
  openssl x509 -req -sha256 -days 365 -in "$target/ca-private/$service.csr" \
    -CA "$target/tls/internal-ca.crt" -CAkey "$target/ca-private/ca.key" -CAcreateserial \
    -extfile "$target/ca-private/$service.ext" -out "$target/tls/$service.crt" >/dev/null 2>&1
  openssl verify -CAfile "$target/tls/internal-ca.crt" -verify_hostname "$service" "$target/tls/$service.crt" >/dev/null
done

openssl rand -hex 32 > "$target/postgres/bootstrap_password"
openssl rand -hex 32 > "$target/api/runtime_db_password"
openssl rand -hex 32 > "$target/migration/migration_db_password"
openssl rand -hex 32 > "$target/api/redis_password"
redis_hash=$(tr -d '\r\n' < "$target/api/redis_password" | sha256sum | cut -d ' ' -f 1)
printf 'user default off\nuser zzsh_app on #%s -@all +auth +hello +ping +client|setinfo +client|setname\n' "$redis_hash" > "$target/redis/users.acl"

install -o root -g 1000 -m 0640 "$target/tls/internal-ca.crt" "$target/api/internal-ca.crt"
install -o root -g 1000 -m 0640 "$target/tls/internal-ca.crt" "$target/migration/internal-ca.crt"
install -o root -g 1000 -m 0640 "$target/api/redis_password" "$target/migration/redis_password"
chown root:1000 "$target/api/runtime_db_password" "$target/api/redis_password" "$target/migration/migration_db_password" "$target/redis/users.acl"
chmod 0640 "$target/api/runtime_db_password" "$target/api/redis_password" "$target/migration/migration_db_password" "$target/redis/users.acl"
chown 70:70 "$target/tls/postgres.key"
chown 999:1000 "$target/tls/redis.key"
chmod 0600 "$target/tls/postgres.key" "$target/tls/redis.key"
chmod 0644 "$target/tls/internal-ca.crt" "$target/tls/postgres.crt" "$target/tls/redis.crt"
echo 'Internal CA, server certificates and service passwords created. Preserve them securely.'
