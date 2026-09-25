const fs = require('fs');
const path = require('path');

const distDir = path.join(__dirname, 'dist');
if (!fs.existsSync(distDir)) {
    fs.mkdirSync(distDir, { recursive: true });
}

const filesToCopy = [
    'index.html',
    'style.css',
    'app.js',
    'calling.js',
    'manifest.json',
    'service-worker.js'
];

filesToCopy.forEach(file => {
    const srcPath = path.join(__dirname, file);
    const destPath = path.join(distDir, file);
    if (fs.existsSync(srcPath)) {
        fs.copyFileSync(srcPath, destPath);
        console.log(`[build-dist] Copied ${file} -> dist/${file}`);
    }
});

// Copy Capacitor runtime & Firebase Authentication plugin bundles
const capCorePath = path.join(__dirname, 'node_modules/@capacitor/core/dist/capacitor.js');
if (fs.existsSync(capCorePath)) {
    fs.copyFileSync(capCorePath, path.join(distDir, 'capacitor.js'));
    fs.copyFileSync(capCorePath, path.join(__dirname, 'capacitor.js'));
    console.log('[build-dist] Copied capacitor.js -> dist/capacitor.js & root');
}

const capAuthPath = path.join(__dirname, 'node_modules/@capacitor-firebase/authentication/dist/plugin.js');
if (fs.existsSync(capAuthPath)) {
    fs.copyFileSync(capAuthPath, path.join(distDir, 'capacitor-firebase-auth.js'));
    fs.copyFileSync(capAuthPath, path.join(__dirname, 'capacitor-firebase-auth.js'));
    console.log('[build-dist] Copied capacitor-firebase-auth.js -> dist/capacitor-firebase-auth.js & root');
}

// Copy assets folder (icons, logos)
function copyDirSync(src, dest) {
    if (!fs.existsSync(src)) return;
    if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const entry of entries) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);
        if (entry.isDirectory()) {
            copyDirSync(srcPath, destPath);
        } else {
            fs.copyFileSync(srcPath, destPath);
        }
    }
}

copyDirSync(path.join(__dirname, 'assets'), path.join(distDir, 'assets'));
console.log('[build-dist] Copied assets -> dist/assets');

console.log('[build-dist] Distribution bundle built successfully in dist/');
