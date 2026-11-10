# AGENTS.md

DevFest GDGoC Japan Hackathon 2026（教育カテゴリ）の提出プロダクトのリポジトリ。
AIが学生の質問に答え、答えられないものは教員に回し、やり取りを講義ごとのナレッジベースとして蓄積するWebアプリ。

このファイルは、Claude Code・Codex・Antigravity など、すべてのAIエージェント共通のルール。ツール固有の設定はそれぞれのファイル（CLAUDE.md など）に書く。

> TODO: プロダクト名が決まったら書き換える

## ドキュメント（docs/）

仕様の正本は `docs/`。このファイルには要点と案内だけを書く。作業前に、関係するものを読むこと。

| ファイル | 内容 | 状態 |
|---|---|---|
| `docs/decisions.md` | 決定ログ。何を、なぜ決めたか。合意済みか要確認かも書く | あり |
| `docs/データ設計.md` | Firestoreのデータ設計、質問の状態遷移、ナレッジの連動ルール | 初期案 |
| `docs/product-spec.md` | ハッカソン提出用のプロダクト説明ドキュメント（審査項目・Own the Why完全準拠） | あり |
| `docs/overview.md` | ハッカソンの概要（期間、提出物、審査基準、ルール） | あり |
| `docs/plan.md` | 計画書（機能、優先順位、デモの流れ） | あり |
| `docs/implementation/README.md` | A〜Dの担当別実装設計書と共通契約 | 提案・要確認 |
| `docs/implementation/c-interfaces.md` | C担当が実装した型・API・ストア（A/B/Dの接続先） | 実装済み・レビュー前 |
| `docs/著作物利用.md` | このリポジトリで追加した依存の出典とライセンス | あり |

### docs の運用ルール

- **設計を変えるときは、コードより先に docs を更新し、同じ PR に含める。** コードと docs が食い違ったら、docs を正とする
- **チームで決めたことは `docs/decisions.md` に1行で残す。** 議事録の決定事項もここに転記する（議事録の PDF 自体はリポジトリに置かない）
- `decisions.md` で「要確認」となっている項目を、AIエージェントは確定事項として扱わない。実装が必要なら、差し替えやすい形で作り、PR に「要確認事項に依存」と書く
- 「初期値」となっている数値や設定は、実装しながら変えてよい。変えたら `decisions.md` を更新する
- AIエージェントが書いた docs の変更は、人が読んでからマージする

## 技術スタック

- Next.js（TypeScript、App Router）
- Firebase App Hosting
- Firestore（Firebase Admin SDK でサーバー側から読み書きする）
- Firebase Authentication（Google と登録済みアカウントのメール／パスワード。ブラウザではログインだけに使い、サーバーで検証する）
- Gemini を Vertex AI 経由で呼ぶ（Google Gen AI SDK）
  - モデル名：gemini-2.5-flash、ロケーション：global（動作確認済みプロジェクト：hackathon-513708）
- 開発環境：Dev Container（Node.js 24、npm、Firebase CLI、Java 21）。セットアップは README.md を参照
- リージョン（初期値）：App Hosting は asia-east1、Firestore は asia-northeast1

## 設計方針（提出用アプリ）

以下は提出用アプリの方針。`test/` の PoC には適用しない。

- **認証は Firebase Authentication。生徒・教員とも Google でログインでき、審査用に登録済みアカウントのメール／パスワードも使える。** 詳細は `docs/データ設計.md` の「認証と URL」
  - 理由：生徒は授業中は学校の PC、家ではスマホと端末が変わるため、アカウントで個人を識別する
  - ブラウザで使う Firebase SDK は `firebase/auth`（ログイン）だけ。Firestore にブラウザから直接アクセスしない
  - サーバーは Admin SDK でログイン情報（ID トークンまたはセッション Cookie）を検証し、`uid` とメールアドレスを取り出す。**ブラウザが送ってくる uid・役割・メールアドレスは信用しない**
  - 教員の判定は、講義の `teacherEmails` に検証済みメールアドレスが含まれるかどうか。URL に秘密の値は含めない
  - **権限の確認（この人は教員か、この質問の持ち主か）は `src/server/auth/` の1か所にまとめる。** 本番では大学のアカウントに切り替える想定なので、ログイン方式を差し替えやすくしておく
  - 質問データには `uid` と、相談作成時点のアカウントの表示名（なければ検証済みメール）を保存する。表示名は担当教員にだけ返し、他の生徒・公開Q&Aには出さない（11/7）
- **Admin SDK はセキュリティルールを通らない。** サーバー側から読み書きする処理では、コードの中で権限を確認しないと、誰でもデータを読めてしまう
- 質問の原文（非公開）と、匿名化したナレッジ（同じ講義の受講者に公開）は別のコレクションにする
- ナレッジ検索にベクトルは使わない。Gemini で質問をカテゴリに分類し、該当するナレッジを Firestore で絞り込んでプロンプトに入れる（件数などの初期値は `docs/データ設計.md`）
- AIが自信のない回答（escalate=true）はナレッジに入れない

## ルール

- **パッケージマネージャは npm のみ。** pnpm / yarn は使わない（lockfile は package-lock.json）
- **`test/` は削除前提の PoC。提出用アプリにコードをコピー・流用しない（大会ルールで禁止）。提出前に `test/` を削除する**
- 実際の値が入った `.env.local` やサービスアカウントの鍵はコミットしない。値の見本である `.env.example` はコミットする。本番の秘密の値は `apphosting.yaml` の secret（Cloud Secret Manager）で渡す
- Gemini はサーバー側だけで呼ぶ。応答は JSON（構造化出力）で受け取り、型を検証してから使う
- Google Cloud のクレジットは1チーム20ドル。Gemini をループやポーリングの中で呼ばない。大量のリクエストを使う前にはチームに相談する
- 新しいライブラリや素材（画像・フォント・講義資料など）を追加したら、著作物利用シートに名前・出典・ライセンスを書き足す
- 講義資料は、使用許可のあるもの、利用条件が明記された公開資料、または自作のものだけを使う

## コマンド

コマンドはすべて Dev Container の中で実行する。ホスト（Windows）には Node.js がない前提。

```bash
npm run emulators   # ターミナル1
npm run dev         # ターミナル2
npm run lint
npm run typecheck
npm run build
npm run check:rules     # 権限・状態遷移の単体テスト
npm run check:auth      # Auth Emulator でログインとセッション（Emulator停止時）
npm run check:firestore # Emulatorを停止した状態で実行
npm run seed:demo       # Emulator起動中にデモデータを投入
```

App Hosting の設定と分担の起点は README.md を参照。

## ブランチ運用

> TODO: チームで決めたルールを書く（main への直接 push の可否、ブランチ名、PR のレビュー）

## 未決事項

- デモの場面（高校の授業／大学の講義／塾・予備校のどれで見せるか）。データ設計は「講義」を単位にしている
- 匿名性・カテゴリの作り方は11/7に決定済み（docs/confirmed-requirements.md）

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
