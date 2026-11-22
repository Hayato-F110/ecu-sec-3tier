# ECU セキュリティ対策状況の管理システム（3層クライアントサーバー開発の練習）

サプライヤが ECU のセキュリティ対策状況を入力・承認し、メーカーが一括で確認する業務システムを、3通りの環境で動かす練習です。データはすべて架空のものです。

| 層 | ローカル | AWS 従来型 | AWS サーバーレス |
| --- | --- | --- | --- |
| 画面 | React ＋ nginx | S3 ＋ CloudFront | S3 ＋ CloudFront |
| 処理 | FastAPI | EC2（ALB の後ろ） | Lambda ＋ API Gateway |
| 保存 | PostgreSQL | RDS | DynamoDB |

## 動かし方（ローカル）

```sh
cp env.example .env   # 値を変える
docker compose up -d
```

（Day 1 の時点では DB だけが起動します）

## 文書

- 仕様：[docs/spec.md](docs/spec.md)
- 日割り：[docs/schedule.md](docs/schedule.md)
- 設計判断：[docs/design-decisions.md](docs/design-decisions.md)
- Claude Code の設定：[docs/claude-setup.md](docs/claude-setup.md)

## 2つの構成の比較

（Day 17 に書く）
