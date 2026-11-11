# Instalação

## No navegador (PWA)
```bash
npm install
npm run dev    # http://localhost:5173
npm run build  # gera dist/
```
Também pode ser instalado como PWA (Chrome/Edge: menu → Instalar app). Funciona offline.

## App de desktop (Tauri v2)
O projeto já inclui o scaffold completo em `src-tauri/` (Cargo, ícones, capabilities e CSP).

### Pré-requisitos
- **Node 20+** e npm
- **Rust** (stable) — instale em https://rustup.rs
- **Dependências do sistema:**
  - Windows: Microsoft Visual Studio C++ Build Tools + WebView2 (já vem no Windows 10/11)
  - macOS: Xcode Command Line Tools (`xcode-select --install`)
  - Linux (Debian/Ubuntu): `sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev`

### Rodar em modo desenvolvimento
```bash
npm install
npm run tauri:dev
```
O Tauri sobe o Vite automaticamente (`beforeDevCommand`) e abre a janela do app.

### Gerar o instalador
```bash
npm run tauri:build
```
Os artefatos ficam em `src-tauri/target/release/bundle/`:
- Windows: `.msi` (WiX) e `.exe` (NSIS)
- macOS: `.app` e `.dmg`
- Linux: `.deb`, `.rpm` e `.AppImage`

Para gerar só um formato: `npm run tauri:build -- --bundles nsis` (Windows) ou `--bundles deb,appimage` (Linux).

### Ícones
Os ícones em `src-tauri/icons/` foram gerados a partir de `public/icon-512.png`. Para regerar após trocar a arte:
```bash
npx tauri icon public/icon-512.png
```

## Backup
Ajustes → Baixar cópia / Restaurar cópia. No desktop os dados ficam no armazenamento local do WebView e continuam funcionando offline.
