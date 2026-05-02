const http = require("http");
const { exec } = require("child_process");

const PORT = 3001;

function send(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(body);
}

function run(cmd, res) {
  exec(cmd, { shell: "/bin/bash", maxBuffer: 1024 * 1024 * 80 }, (err, stdout, stderr) => {
    const output = stdout + "\n" + stderr;
    if (err) return send(res, 500, output + "\nERROR: " + err.message);
    return send(res, 200, output);
  });
}

const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") {
    return send(res, 200, "ok");
  }

  // Manual: abre UMA rodada e para.
  if (req.url === "/open-draw") {
    const cmd = `
cd ~/projects/megabyt && \\
ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \\
ANCHOR_WALLET=~/.config/solana/id.json \\
DURATION=60 \\
npx ts-node --transpile-only scripts/open-draw.ts
`;
    return run(cmd, res);
  }

  // Fecha/finaliza/paga a rodada atual e para.
  // NÃO abre a próxima automaticamente.
  if (req.url === "/close-draw") {
    const cmd = `
cd ~/projects/megabyt && \\
ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \\
ANCHOR_WALLET=~/.config/solana/id.json \\
npx ts-node --transpile-only scripts/demo-close-current-draw.ts
`;
    return run(cmd, res);
  }

  // Full demo continua sendo o modo automático completo separado.
  if (req.url === "/run-demo") {
    const cmd = `
cd ~/projects/megabyt && \\
ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \\
ANCHOR_WALLET=~/.config/solana/id.json \\
TICKETS=25 \\
MULTI=5 \\
DURATION=60 \\
npx ts-node --transpile-only scripts/flow-master-final.ts
`;
    return run(cmd, res);
  }

  return send(res, 200, "MegaByt demo server ready");
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("MegaByt demo server running on http://0.0.0.0:" + PORT);
});
