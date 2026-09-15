import fs from "fs";
import path from "path";

import type { ServiceAccount } from "firebase-admin";
import { cert, getApps, initializeApp, type App } from "firebase-admin/app";
import { getMessaging, type Messaging } from "firebase-admin/messaging";

let app: App | null = null;

function parseMultilineJsonFromEnvFile(): ServiceAccount | null {
  const envPath = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) return null;

  const content = fs.readFileSync(envPath, "utf8");
  const marker = "FIREBASE_SERVICE_ACCOUNT_JSON=";
  const start = content.indexOf(marker);
  if (start === -1) return null;

  let jsonStart = start + marker.length;
  while (jsonStart < content.length && content[jsonStart] === " ") jsonStart += 1;
  if (content[jsonStart] !== "{") return null;

  let depth = 0;
  let i = jsonStart;
  for (; i < content.length; i += 1) {
    const char = content[i];
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        i += 1;
        break;
      }
    }
  }

  try {
    return JSON.parse(content.slice(jsonStart, i)) as ServiceAccount;
  } catch {
    return null;
  }
}

function loadServiceAccount(): ServiceAccount | null {
  const accountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  if (accountPath) {
    const resolved = path.resolve(process.cwd(), accountPath);
    if (fs.existsSync(resolved)) {
      return JSON.parse(fs.readFileSync(resolved, "utf8")) as ServiceAccount;
    }
  }

  const inlineJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (inlineJson) {
    try {
      return JSON.parse(inlineJson) as ServiceAccount;
    } catch {
      // dotenv often truncates multiline JSON — fall through to file parser
    }
  }

  return parseMultilineJsonFromEnvFile();
}

export function getFirebaseAdmin(): App | null {
  if (app) return app;

  const serviceAccount = loadServiceAccount();
  if (!serviceAccount) {
    console.warn("[firebase-admin] Service account not configured — push disabled");
    return null;
  }

  if (getApps().length > 0) {
    app = getApps()[0]!;
    return app;
  }

  app = initializeApp({
    credential: cert(serviceAccount),
  });
  return app;
}

export function getFirebaseMessaging(): Messaging | null {
  const firebaseApp = getFirebaseAdmin();
  if (!firebaseApp) return null;
  return getMessaging(firebaseApp);
}
