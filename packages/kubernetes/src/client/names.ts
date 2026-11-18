const NamespacePattern = /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/
const ResourceNamePattern =
  /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?)*$/
const KeyPattern = /^[A-Za-z0-9._-]+$/
const LabelPattern = /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/

/** One same-namespace Pod owner reference. */
interface PodOwnerName {
  readonly name: string
  readonly uid: string
}

/** Validates one Kubernetes namespace name without normalizing it. */
export function kubernetesNamespace(value: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 63 ||
    !NamespacePattern.test(value)
  ) {
    throw new TypeError("Kubernetes namespace must be a DNS-1123 label")
  }
  return value
}

/** Validates one ConfigMap or Secret name without normalizing it. */
export function kubernetesResourceName(value: string): string {
  if (typeof value !== "string" || value.length > 253 || !ResourceNamePattern.test(value)) {
    throw new TypeError("Kubernetes resource name must be a DNS subdomain")
  }
  return value
}

/** Validates one ConfigMap or Secret data key without normalizing it. */
export function kubernetesKey(value: string): string {
  if (typeof value !== "string" || value.length > 253 || !KeyPattern.test(value)) {
    throw new TypeError(
      "Kubernetes key must contain only letters, digits, dot, underscore, or dash"
    )
  }
  return value
}

/** Snapshots one optional same-namespace Pod owner reference. */
export function kubernetesPodOwner(value: PodOwnerName | undefined): PodOwnerName | null {
  if (value === undefined) return null
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Kubernetes owner must identify one Pod")
  }
  const name = value.name
  const uid = value.uid
  if (
    typeof name !== "string" ||
    name.length < 1 ||
    name.length > 253 ||
    name.split(".").some((label) => !LabelPattern.test(label))
  ) {
    throw new TypeError("Kubernetes owner name must be a DNS-1123 subdomain")
  }
  if (typeof uid !== "string" || uid.length === 0) {
    throw new TypeError("Kubernetes owner uid must be a non-empty string")
  }
  return Object.freeze({ name, uid })
}
