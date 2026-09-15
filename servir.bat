@echo off
rem Sobe um servidor HTTP local para testar o Kanban.
rem Necessario porque index.html usa <script type="module"> (nao abre via file://).
cd /d "%~dp0"
echo.
echo  Quadro de Fluxo - servidor local
echo  Abra no navegador:  http://localhost:5500
echo  Para parar: feche esta janela ou pressione Ctrl+C
echo.
start "" http://localhost:5500
python servidor.py 5500
