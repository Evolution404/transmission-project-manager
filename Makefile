SHELL := /bin/bash
.DEFAULT_GOAL := help

.PHONY: help install doctor dev dev-api dev-web typecheck build build-web build-worker test test-unit test-ui check audit engineering-audit security-audit ci production-preflight production production-inventory status

help:
	@printf '%s\n' \
	  '输电项目管理工程命令' \
	  '' \
	  '  make install              安装锁定依赖（npm ci）' \
	  '  make doctor               检查 Node/npm/GitHub CLI 与仓库状态' \
	  '  make dev                  一键启动本地 API + Web（Web: 5173 / API: 8787）' \
	  '  make dev-api              仅启动本地 API' \
	  '  make dev-web              仅启动本地 Web' \
	  '  make test                 一键完整测试：check + Headless UI E2E' \
	  '  make test-unit            Node + Web 行为测试' \
	  '  make test-ui              Headless Chromium 真实 UI 验收' \
	  '  make check                完整代码门禁（类型/构建/Node/Web）' \
	  '  make audit                工程卫生 + 生产依赖安全审计' \
	  '  make engineering-audit    仅扫描 Git 真源的工程卫生/维护热点' \
	  '  make security-audit       使用 npm 官方 advisory API 审计生产依赖' \
	  '  make build                Web + Worker production build/dry-run' \
	  '  make ci                   触发并等待当前分支 GitHub CI' \
	  '  make production-preflight 触发并等待 main 的生产无变更预检' \
	  '  make production           一键触发并等待受保护的 Production promote' \
	  '  make production-inventory 一键读取生产 Cloudflare inventory（只读）' \
	  '  make status               查看 Git / 最近提交状态'

install:
	npm ci

doctor:
	@node --version
	@npm --version
	@gh --version | head -n 1
	@gh auth status
	@git status --short --branch

dev:
	npm run dev

dev-api:
	npm run dev:api

dev-web:
	npm run dev:web

typecheck:
	npm run typecheck

build:
	npm run build

build-web:
	npm run build:web

build-worker:
	npm run build:worker

test: check test-ui

test-unit:
	npm test

test-ui:
	npm run test:ui:headless

check:
	npm run check

audit: engineering-audit security-audit

engineering-audit:
	npm run engineering:audit

security-audit:
	npm run security:audit

ci:
	node scripts/engineering/github-workflow.mjs ci.yml --ref current

production-preflight:
	node scripts/engineering/github-workflow.mjs production-preflight.yml --ref main --require-main-sync

production:
	node scripts/engineering/github-workflow.mjs production-promote.yml --ref main --require-main-sync

production-inventory:
	node scripts/engineering/github-workflow.mjs production-cloudflare-inventory.yml --ref main --require-main-sync

status:
	@git status --short --branch
	@git log --oneline --decorate --max-count=12
