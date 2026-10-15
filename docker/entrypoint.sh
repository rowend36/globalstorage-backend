#!/bin/sh
set -eu

npm run migration:up:compiled
exec node dist/main.js
