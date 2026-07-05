#!/usr/bin/env node
/**
 * genimg.mjs — Gemini画像生成CLI（gemini-2.5-flash-image）
 *
 * 使い方:
 *   node scripts/genimg.mjs "<日本語プロンプト>" <出力.png> [--style <テーマ名>] [--ar 16:9|1:1|3:4|4:3]
 *   node scripts/genimg.mjs --list-styles
 *
 * APIキーの取得順: 環境変数 GEMINI_API_KEY → ~/.config/slidesmith/credentials.json
 * キー未設定の場合は setup-gemini.mjs の実行を案内します。
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";

const MODEL = "gemini-2.5-flash-image";
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
const CREDENTIALS_PATH = join(homedir(), ".config", "slidesmith", "credentials.json");

/** テーマ名 → 画風レシピ（プロンプトに追記する英語スタイル指定） */
const STYLES = {
  corporate: "clean corporate photography, soft natural light, shallow depth of field, muted navy and teal tones",
  pop: "vibrant flat illustration style, bold colors, playful, sticker-like",
  elegant: "quiet luxury photography, dark moody tones, gold accents, japanese aesthetics, tranquil",
  minimal: "minimalist photography, white background, single object, strong shadow, monochrome",
  tech: "futuristic 3D render, dark background, neon cyan glow, sleek",
  warm: "film photography, warm natural light, cozy, earthy tones, kinfolk style",
  feminine: "soft airy photography, pastel tones, delicate, high-key light",
  retro: "showa era retro japan, nostalgic film photo, warm faded colors",
};

/** 文字混入防止の共通追記 */
const NO_TEXT_SUFFIX = "no text, no letters, no watermark";

const SUPPORTED_AR = ["16:9", "1:1", "3:4", "4:3", "9:16", "3:2", "2:3", "21:9", "5:4", "4:5"];
const DEFAULT_AR = "16:9";

function printHelp() {
  console.log(`genimg.mjs — Gemini画像生成CLI（モデル: ${MODEL}）

使い方:
  node scripts/genimg.mjs "<日本語プロンプト>" <出力.png> [--style <テーマ名>] [--ar <比率>]
  node scripts/genimg.mjs --list-styles

オプション:
  --style <名前>   画風テーマ（--list-styles で一覧表示）
  --ar <比率>      アスペクト比: 16:9 | 1:1 | 3:4 | 4:3 など（既定: ${DEFAULT_AR}）
  --list-styles    内蔵スタイル8種を表示
  --help           このヘルプを表示

例:
  node scripts/genimg.mjs "会議室で談笑するビジネスパーソン" hero.png --style corporate --ar 16:9

※ 生成画像には自動で「${NO_TEXT_SUFFIX}」を追記します（文字混入防止）。`);
}

function printStyles() {
  console.log("内蔵スタイル一覧（--style で指定）:\n");
  for (const [name, recipe] of Object.entries(STYLES)) {
    console.log(`  ${name.padEnd(10)} ${recipe}`);
  }
  console.log(`\n計 ${Object.keys(STYLES).length} スタイル`);
}

async function loadApiKey() {
  const envKey = process.env.GEMINI_API_KEY?.trim();
  if (envKey) return envKey;

  try {
    const raw = await readFile(CREDENTIALS_PATH, "utf8");
    const key = JSON.parse(raw)?.gemini_api_key?.trim();
    if (key) return key;
  } catch {
    // ファイルなし・破損は下のエラーメッセージに集約
  }

  console.error("エラー: Gemini APIキーが見つかりません。");
  console.error("まず次のコマンドでセットアップしてください:");
  console.error("  node scripts/setup-gemini.mjs");
  console.error("（または環境変数 GEMINI_API_KEY を設定してください）");
  process.exit(1);
}

function parseArgs(argv) {
  const positional = [];
  let style = null;
  let ar = DEFAULT_AR;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") return { mode: "help" };
    if (a === "--list-styles") return { mode: "list-styles" };
    if (a === "--style") {
      style = argv[++i];
      if (!style) fail("--style にテーマ名を指定してください（--list-styles で一覧表示）");
      continue;
    }
    if (a === "--ar") {
      ar = argv[++i];
      if (!ar) fail("--ar にアスペクト比を指定してください（例: 16:9）");
      continue;
    }
    if (a.startsWith("--")) fail(`不明なオプション: ${a}（--help で使い方を表示）`);
    positional.push(a);
  }

  if (positional.length < 2) {
    fail('引数が不足しています。使い方: node scripts/genimg.mjs "<プロンプト>" <出力.png> [--style <名前>] [--ar 16:9]\n--help で詳細を表示します。');
  }
  if (style && !STYLES[style]) {
    fail(`不明なスタイル: ${style}\n利用可能: ${Object.keys(STYLES).join(", ")}`);
  }
  if (!SUPPORTED_AR.includes(ar)) {
    fail(`未対応のアスペクト比: ${ar}\n利用可能: ${SUPPORTED_AR.join(", ")}`);
  }

  return { mode: "generate", prompt: positional[0], outPath: resolve(positional[1]), style, ar };
}

function fail(message) {
  console.error(`エラー: ${message}`);
  process.exit(1);
}

function buildPrompt(userPrompt, styleName) {
  const parts = [userPrompt];
  if (styleName) parts.push(STYLES[styleName]);
  parts.push(NO_TEXT_SUFFIX);
  return parts.join(", ");
}

async function handleHttpError(res) {
  const bodyText = await res.text().catch(() => "");
  let apiMessage = "";
  try {
    apiMessage = JSON.parse(bodyText)?.error?.message ?? "";
  } catch {
    apiMessage = bodyText.slice(0, 300);
  }

  switch (res.status) {
    case 400:
    case 401:
    case 403:
      console.error(`エラー (HTTP ${res.status}): APIキーが不正、またはリクエスト内容に問題があります。`);
      console.error("node scripts/setup-gemini.mjs でキーを設定し直してみてください。");
      break;
    case 429:
      console.error("エラー (HTTP 429): リクエスト上限（クォータ）に達しました。");
      console.error("無料枠の場合は数分〜24時間待つか、有料プランへの切り替えを検討してください。");
      break;
    case 500:
    case 502:
    case 503:
      console.error(`エラー (HTTP ${res.status}): Gemini側のサーバーエラーです。少し待って再実行してください。`);
      break;
    default:
      console.error(`エラー (HTTP ${res.status}): 画像生成に失敗しました。`);
  }
  if (apiMessage) console.error(`APIからのメッセージ: ${apiMessage}`);
  process.exit(1);
}

function extractImage(data) {
  // 安全フィルタでブロックされたケース
  const blockReason = data?.promptFeedback?.blockReason;
  if (blockReason) {
    console.error(`エラー: プロンプトが安全フィルタでブロックされました（理由: ${blockReason}）。`);
    console.error("表現をマイルドにする・固有名詞や人物指定を外す、などプロンプトを調整して再実行してください。");
    process.exit(1);
  }

  const candidate = data?.candidates?.[0];
  const finishReason = candidate?.finishReason;
  const parts = candidate?.content?.parts ?? [];
  const imagePart = parts.find((p) => p.inlineData?.data);

  if (!imagePart) {
    if (finishReason && finishReason !== "STOP") {
      console.error(`エラー: 画像が生成されませんでした（finishReason: ${finishReason}）。`);
      if (finishReason === "IMAGE_SAFETY" || finishReason === "SAFETY" || finishReason === "PROHIBITED_CONTENT") {
        console.error("安全フィルタによるブロックです。プロンプトの表現を調整して再実行してください。");
      }
    } else {
      const text = parts.find((p) => p.text)?.text;
      console.error("エラー: レスポンスに画像データ（inlineData）が含まれていませんでした。");
      if (text) console.error(`モデルの応答テキスト: ${text.slice(0, 300)}`);
    }
    process.exit(1);
  }
  return imagePart.inlineData;
}

async function generate({ prompt, outPath, style, ar }) {
  const apiKey = await loadApiKey();
  const fullPrompt = buildPrompt(prompt, style);

  console.log(`モデル       : ${MODEL}`);
  console.log(`アスペクト比 : ${ar}`);
  if (style) console.log(`スタイル     : ${style}`);
  console.log(`プロンプト   : ${fullPrompt}`);
  console.log("画像を生成しています…（10〜30秒ほどかかります）");

  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "x-goog-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: fullPrompt }] }],
        generationConfig: {
          responseModalities: ["IMAGE"],
          imageConfig: { aspectRatio: ar },
        },
      }),
      signal: AbortSignal.timeout(120000),
    });
  } catch (err) {
    console.error("エラー: Gemini APIに接続できませんでした。ネットワーク接続を確認してください。");
    console.error(`詳細: ${err?.cause?.message ?? err.message}`);
    process.exit(1);
  }

  if (!res.ok) await handleHttpError(res);

  const data = await res.json().catch(() => {
    fail("レスポンスのJSON解析に失敗しました。");
  });
  const inlineData = extractImage(data);

  const buffer = Buffer.from(inlineData.data, "base64");
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, buffer);

  const sizeKb = (buffer.length / 1024).toFixed(1);
  console.log("");
  console.log("生成完了！");
  console.log(`  出力先     : ${outPath}`);
  console.log(`  サイズ     : ${sizeKb} KB（${inlineData.mimeType ?? "image/png"}）`);
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.mode === "help") return printHelp();
  if (parsed.mode === "list-styles") return printStyles();
  await generate(parsed);
}

main().catch((err) => {
  console.error(`予期しないエラー: ${err.message}`);
  process.exit(1);
});
