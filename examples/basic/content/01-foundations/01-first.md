---
title: First note
order: 1
number: F1
---

This first sentence becomes the automatic summary. A second sentence should not be required.

## Request path

Read the [second note](02-second.md#second-section) and the [local data](sample.txt).

The commit result survives a lost response.[^commit]

[^commit]: The write-ahead log reached the configured durability boundary.

```ts
const unsafe = "<script>&";
```

<script>alert("raw HTML must not run")</script>

```mermaid
flowchart LR
  accTitle: A small request path
  accDescr: A client sends a request to an application, which writes to a database.
  client[Client] --> app[Application]
  app --> database[(Database)]
```
