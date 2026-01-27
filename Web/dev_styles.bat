@echo off
title Tailwind CSS Auto Compiler

echo.
echo ==========================================
echo       Tailwind CSS Compiler Tool
echo ==========================================
echo.

if not exist "tailwindcss.exe" (
    echo [ERROR] tailwindcss.exe not found!
    echo.
    echo Please follow these steps:
    echo 1. Download tailwindcss-windows-x64.exe from GitHub
    echo 2. Rename it to tailwindcss.exe
    echo 3. Place it in this folder
    echo.
    pause
    exit
)

echo [INFO] Starting Watch Mode...
echo [INFO] Edit your input.css or HTML files to trigger updates.
echo [INFO] Do NOT close this window.
echo.

:: Run the command
tailwindcss.exe -i input.css -o style.css --watch
