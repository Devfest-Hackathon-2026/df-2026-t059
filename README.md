# GDGoC Japan Hackathon 2026 ^^
デプロイURL: https://hackathon-app--hackathon-513708.asia-east1.hosted.app

授業の質問にAIが一次回答し、難しい質問を教員に引き継ぐWebアプリです。講義で共有できるQ&Aは、質問原文と分けて管理します。

## ローカルで開発する

Docker Desktop を起動し、VS Code の **Dev Containers: Reopen in Container** でリポジトリを開きます。コンテナには Node.js 24、npm、Firebase CLI、Java 21 が入っています。初回セットアップは `npm ci` を実行し、`.env.local` がなければ `.env.example` をコピーします。

すでに開いているコンテナで変更を取り込んだ場合は、ルートで `npm ci` を実行してください。`.env.local` がなければ `cp .env.example .env.local` で作ります。既存ファイルはローカル用の `GCLOUD_PROJECT`、`FIRESTORE_EMULATOR_HOST`、`FIREBASE_AUTH_EMULATOR_HOST`、`NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST` があるか確認し、なければ `.env.example` から足してください。Auth Emulator の2行がないと、ログインのポップアップがすぐ閉じて `auth/api-key-not-valid` で失敗します（`NEXT_PUBLIC_` の値を変えたら `npm run dev` を再起動）。

```bash
# ターミナル1
npm run emulators

# ターミナル2
npm run dev
```

アプリは [localhost:3000](http://localhost:3000)、Emulator UI は [localhost:4000](http://localhost:4000) です。開発中のデータは、Emulator を Ctrl+C で終了すると `.emulator-data/` に保存されます。

トップページ `/` はログイン後に参加中・担当中の講義を表示します。「講義を作成」から講義名を入力すると、自分が担当する教員画面へ移ります。担当講義から生徒の招待を発行できます。招待を受け取った人は招待URLを開くか、講義一覧の「招待から参加」から参加します。

開発用の `/preview` は `/api/preview/chat` 経由で Gemini に接続します。会話は画面内だけで保持し、リロードすると消えます。本番ではプレビュー画面とAPIは404になります。[プレビュー接続の仕様](docs/implementation/preview-chat.md)

保存・教員への引き継ぎを行う講義機能は `/c/講義ID` です。生徒は固定の参加URL `/join/講義ID` または共有IDで講義を指定し、初回はログインして教員から受け取った30分有効の参加コードを入力します。担当教員は `/t/講義ID` の「講義の設定」で参加URL・共有IDを確認し、参加コードを発行できます。

```bash
npm run lint
npm run typecheck
npm run build
npm run check:preview # プレビューAPIのモックテスト（Geminiは呼ばない）
npm run check:preview:http # 起動中のNext.jsとの結合確認（既定ではGeminiを呼ばない）
```

ブラウザの通し操作は Dev Container 内で `npm exec -- playwright install --with-deps --only-shell chromium` を初回に実行し、起動中の Next.js と Emulator を停止して `npm run check:browser` を実行します。Next.js の本番ビルドを作り、固定 AI 応答と一時データで Next.js（ポート 3100）・Auth・Firestore Emulator を起動します。既定の Chromium キャッシュに書けない場合は、インストール・実行の両方で `PLAYWRIGHT_BROWSERS_PATH=/tmp/gdgoc-playwright` を指定してください。[提出前のテスト報告](docs/hackathon/test-report.md)

Emulator を起動していない状態で `npm run check:firestore` を実行すると、一時的な Firestore・Auth Emulator で権限・状態遷移・競合を確認できます。`npm run check:rules` は Emulator なしで権限と状態遷移の単体テストを、`npm run check:auth` は Auth Emulator でログインとセッション Cookie を確認します。

Emulator を起動した状態で `npm run seed:demo` を実行すると、デモ用の講義 `math-i`（公開Q&A・招待・状態ごとの相談）を作ります。表示された参加URLを開いて Auth Emulator でログインし、表示された参加コードを入力します。コードの期限が過ぎたら `teacher@example.com` で `/t/math-i` を開き、講義の設定から発行します。デモを作り直すときは `npm run seed:demo -- --reset` です。

ログインには Firebase Authentication を使います。Google または登録済みアカウントのメール／パスワードでログインできます。ローカルでは `.env.example` の `NEXT_PUBLIC_FIREBASE_*` と `FIREBASE_AUTH_EMULATOR_HOST` で Auth Emulator（[localhost:9099](http://localhost:9099)）に接続します。既存の `.env.local` には、`.env.example` に増えた行を足してください。検証用の講義と質問は終了時に削除します。

## ディレクトリと分担

```text
src/
  app/                  ホーム、ログイン、参加、講義ページ、API の入口
  components/           生徒・教員・プレビューで使う共通UI
  domain/               SDK に依存しない型とデータ契約
  features/
    auth/               ログイン・招待フォーム、URL、ブラウザのセッション表示
    courses/            新しい講義の作成フォーム
    student/            A: 生徒画面、表示用の型、質問操作
    teacher/            B: 教員画面、返信、共有候補・招待の操作
    preview/            開発用プレビューの画面、サンプルデータ、チャット
    questions/          共通ストアへの旧来の参照先
  server/
    auth/               C: セッション検証、講義と質問のアクセス制御
    firestore/          C: Admin SDK、レコード定義と共通ストア
    workflow/           C: 状態遷移と AI 処理の接続
    ai/                 D: Vertex AI 呼び出し、応答検証と固定応答
scripts/                検証スクリプトとデモデータの投入
docs/                   仕様、決定ログ、著作物利用記録
```

4人で着手する際は、A（生徒機能）、B（先生機能）、C（認証・データ基盤）、D（Gemini）の各設計書と共通契約を参照します。 [担当別設計書の一覧](docs/implementation/README.md)

アイコン、ダイアログ、会話、Markdown・LaTeX本文は `src/components/` にあります。生徒画面のカテゴリは講義データから渡し、開発用プレビューはサンプルカテゴリを渡します。

担当ごとにブランチとPRを分け、共通のページ・型・API契約の変更は統合担当と調整します。フィールド名や状態の変更は、コードと同じPRで先に [データ設計](docs/データ設計.md) に反映します。チームで確定した事項は [決定ログ](docs/decisions.md) に残します。

質問・会話・候補・公開Q&Aの保存と取得は `src/server/firestore/workflow.ts` の `workflowStore` が担当します。`CourseActor` は `src/server/auth/actor.ts` の `requireCourseActor` が検証済みのセッション Cookie から組み立てます。原文は講義内の質問者か担当教員だけが取得できます。A/B/D の接続先は [C担当の実装済みインターフェース](docs/implementation/c-interfaces.md) にまとめています。画面やAPIへ渡すときは、表示対象のフィールドだけを選び、Firestore のレコードをそのまま渡さないでください。

## App Hosting と Vertex AI

App Hosting のアプリルートはリポジトリのルートです。バックエンドの Node.js ランタイムは 24 を選び、リージョンは決定ログの初期値を参照します。App Hosting のサービスアカウントで Firestore に接続します。Next.js 16 は公式の Active 対象より新しいため、App Hosting 上のビルドと起動は初回の検証項目に含めます。[対応バージョン表](https://firebase.google.com/docs/app-hosting/frameworks-tooling#nextjs-support-schedule)

公開環境では講義機能から Gemini を使います。Vertex AI への接続には `GOOGLE_CLOUD_PROJECT`・`VERTEX_AI_LOCATION`・`GEMINI_MODEL` と、実行サービスアカウントの `roles/aiplatform.user` が必要です。

ログインは、App Hostingのバックエンドに紐付いたFirebase Webアプリの自動設定を使います。ブラウザ用の `NEXT_PUBLIC_FIREBASE_API_KEY`・`NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`・`NEXT_PUBLIC_FIREBASE_PROJECT_ID` の手動追加は不要です。ローカルなどでAPIキーとプロジェクトIDを明示した場合は、その設定を優先し、Auth Emulatorへの接続も従来どおり行います。[SDKの自動初期化](https://firebase.google.com/docs/app-hosting/firebase-sdks#automatically-initialize-firebase-admin-sdk-and-web-sdks)

Google ログインには Firebase Authentication の Google プロバイダと承認済みドメインが必要です。審査用のメールログインにはメール／パスワードプロバイダと登録済みユーザーが必要です。審査員に担当教員の画面を案内する場合は、検証済みメールを対象講義の `teacherEmails` に登録します。講義機能には Firestore のデータベース・ルール・インデックスの設定も必要です。公開環境の講義では Vertex AI を使います。必要な Vertex AI 設定が不足している場合は、回答・要約の設定エラーとして記録します。

ローカル開発とテストでは、`AI_MODE` 未設定時は固定応答を使います。本番ビルドでも、`demo-` プロジェクトで Firestore と Auth の両 Emulator に接続する検証では同じ切り替えを使えます。ローカルの講義で実モデルを試す場合は、`.env.local` に `AI_MODE=vertex` と上記の Vertex AI 用3変数を設定し、Dev Container 内から ADC を使えるようにします。Windows の ADC は自動ではコンテナに引き継がれません。既存のユーザー ADC を使う場合、コンテナの `/home/node/.config/gcloud/application_default_credentials.json` にリポジトリ外で配置し、所有者を `node`、権限を `600` にします。コンテナを作り直した場合は再設定が必要です。Firebase の `GCLOUD_PROJECT=demo-…` と Emulator 設定はそのままにし、Vertex AI 用の実プロジェクトには `GOOGLE_CLOUD_PROJECT` を使います。変更後は `npm run dev` を再起動してください。

11/8 に `gemini-3.1-flash-lite`・`global` で、トップ画面からの質問・履歴を使う追加質問と、Firebase設定のない本番ビルドからの実回答を確認しました。`/c/講義ID` の分類と回答表示も確認済みです。通常の `check:ai` と `check:preview` は固定実装・モックを使い、実APIを呼びません。実モデルとのHTTP結合確認を再実行する場合は、`PREVIEW_LIVE_TEST=1 npm run check:preview:http` を明示します（実APIを2回呼びます）。

自動ロールアウトは、App Hosting で指定した公開ブランチへの push を契機に、その時点のコードとバックエンド設定を使ってビルド・公開します。`.env.local` は Git 管理外なので反映されません。コンソールの設定を変更して既存コミットで試すときは、App Hosting の「ロールアウトを作成」から再ビルドします。[環境変数の優先順位](https://firebase.google.com/docs/app-hosting/configure#variable_hierarchy)・[自動ロールアウト](https://firebase.google.com/docs/app-hosting/rollouts)

クラウドの初期データは、Firestore・Authentication の設定後に既存の `seed:demo` を使えます。Dev Container 内で Emulator のホスト設定を外し、`GCLOUD_PROJECT`・`GOOGLE_CLOUD_PROJECT` に実プロジェクト、`SEED_TARGET=cloud` と `DEMO_TEACHER_EMAILS` に教員のメールを明示して実行します。クラウド向けシードは講義・公開Q&A・招待だけを作り、生徒アカウントや会話は作りません。既存講義を消す `--reset` は通常使いません。

使用する依存の出典とライセンスは [著作物利用記録](docs/著作物利用.md) にまとめています。
