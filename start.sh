#!/bin/bash

# Change to the folder where this script lives
cd "$(dirname "$0")"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  📡 Grooveline Broadcaster"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Check Node.js
if ! command -v node &>/dev/null; then
    echo ""
    echo "❌ Node.js not found."
    echo "   Install it from: https://nodejs.org"
    echo ""
    read -p "Press Enter to close..."
    exit 1
fi

echo "✓ Node.js $(node -v)"

# Install dependencies on first run
if [ ! -d "node_modules" ]; then
    echo ""
    echo "⏳ First run — installing dependencies (one time only)..."
    npm install
    if [ $? -ne 0 ]; then
        echo ""
        echo "❌ npm install failed. Check your internet connection."
        read -p "Press Enter to close..."
        exit 1
    fi
    echo "✓ Dependencies installed"
fi

echo ""
echo "🚀 Launching app..."
echo ""

npm start

# If npm start exits (app closed or crashed), keep terminal open
EXIT_CODE=$?
if [ $EXIT_CODE -ne 0 ]; then
    echo ""
    echo "⚠️  App exited with code $EXIT_CODE"
    echo "   Check the output above for errors."
    echo ""
    read -p "Press Enter to close..."
fi
