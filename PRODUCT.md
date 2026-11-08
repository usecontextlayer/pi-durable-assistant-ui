# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Standalone Node/Pi Durable host, Vite/React demo, Assistant UI primitives, remote thread-list lifecycle and conversation-scoped ExternalStoreRuntime integration. The [adapter contract](packages/adapter/README.md) owns native identity and lifecycle boundaries; [feature coverage](FEATURES.md) owns supported capabilities and their verification limits. Assistant UI itself remains unchanged.

## Users and purpose

Developers integrating Pi Durable with Assistant UI need a working local demonstration and a reusable adapter. Success means running real native conversations, inspecting their behavior, and consuming the adapter without rebuilding the integration.

## Operating context

Local browser app with durable server storage. Deterministic provider scenarios make the integration reproducible without credentials; real providers supply actual model conversations. The UI must identify deterministic mode honestly.

## Interface commitment

The user selected the standard Assistant UI experience: conversation list, thread and composer. Preserve that familiar composition and styling as native Pi capabilities are added. The feature demonstration takes priority over creating a custom visual identity.
