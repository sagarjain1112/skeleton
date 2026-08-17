#!/bin/bash
set -e

mkdir -p /app/publisher

if [ -d "/solution" ]; then
    cp /solution/release-publisher.mjs /app/publisher/release-publisher.mjs
else
    cp solution/release-publisher.mjs /app/publisher/release-publisher.mjs
fi
