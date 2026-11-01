# Decision 0017: Use native deployment tools and one object-storage provider boundary

Status: accepted; amended by Decision 0018 and by [ADR 0034](./0034-kubernetes-only-deployment-scope.md)

## Decision

Artifact Server does not build a second infrastructure command line on top of
the tools that own the infrastructure.

- Local installations use the direct Artifact Server package.
- One-server installations use Docker Compose.
- Kubernetes installations use Helm.
- Azure installations use the Helm chart on AKS. Artifact Server has no
  Azure-specific installer.

Artifact Server may supply scripts that validate prerequisites or run product
probes, but it does not hide, proxy, or reinterpret an infrastructure plan or
update.

The external server runtime receives one `ObjectStorageProviderFactory`. A
connected provider supplies immutable blob operations, staged-upload
operations, readiness, and shutdown. The runtime, lifecycle inspection, and
integrity scanner do not construct a provider SDK client. AWS SDK types stay in
the S3 adapter. Native GCS and Azure Blob adapters can therefore be added by
implementing the same factory without changing artifact, HTTP, MCP,
authorization, or external-runtime code. The native GCS factory is supported.
The native Azure Blob factory implements the same boundary but remains preview
until it passes a live Azure qualification.

## Consequences

- Operators see the real infrastructure plan and can use native policy,
  approval, drift, import, and state tooling.
- A new object store changes provider composition and deployment configuration,
  not the server core.
- The first-party adapter claim remains evidence-based. An S3-compatible
  service is supported only after it passes the storage contract against the
  actual service.

## Rejected alternatives

### Artifact Server deployment wrapper

Rejected because it would duplicate planning, credentials, state, approvals,
imports, drift handling, failures, and diagnostics while hiding the tool an
operator must still understand during recovery.

### One generic object-storage SDK

Not required. Artifact Server's storage contract is deliberately smaller and
includes its own fingerprint, size, namespace, staging, and immutability rules.
Provider SDKs remain replaceable adapter details.

## Verification

- Dependency checks reject AWS and Google SDK imports outside their adapters,
  and reject Azure SDK imports outside the preview storage adapter.
- The S3 adapter and every future native adapter run the same real-provider
  streaming, immutability, isolation, restart, authorization, and failure
  contract.
- The complete product conformance suite runs against each target before that
  target is advertised as supported.
