#!/bin/bash

cd "$(dirname "$0")"

echo "Iniciando aplicação..."
echo

node index.js

echo
echo "================================"
echo "Aplicação finalizada."
echo "Pressione ENTER para fechar."
echo "================================"
read