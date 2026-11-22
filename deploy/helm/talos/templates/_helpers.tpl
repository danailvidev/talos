{{- define "talos.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "talos.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name (include "talos.name" .) | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}

{{- define "talos.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
app.kubernetes.io/name: {{ include "talos.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "talos.selectorLabels" -}}
app.kubernetes.io/name: {{ include "talos.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: control-plane
{{- end }}

{{- define "talos.controlPlaneServiceAccountName" -}}
{{- default (printf "%s-control-plane" (include "talos.fullname" .)) .Values.serviceAccounts.controlPlane.name }}
{{- end }}

{{- define "talos.workerServiceAccountName" -}}
{{- default (printf "%s-worker" (include "talos.fullname" .)) .Values.serviceAccounts.worker.name }}
{{- end }}

{{- define "talos.digestImage" -}}
{{- $repository := required (printf "%s image.repository is required" .name) .image.repository -}}
{{- $digest := required (printf "%s image.digest is required" .name) .image.digest -}}
{{- if not (regexMatch "^sha256:[a-f0-9]{64}$" $digest) -}}
{{- fail (printf "%s image.digest must be an immutable sha256 digest" .name) -}}
{{- end -}}
{{- printf "%s@%s" $repository $digest -}}
{{- end }}

{{- define "talos.publicUrl" -}}
{{- $url := required "runtime.publicUrl is required" .Values.runtime.publicUrl -}}
{{- if not (regexMatch "^https://[^[:space:]]+$" $url) -}}
{{- fail "runtime.publicUrl must be an HTTPS URL" -}}
{{- end -}}
{{- $url -}}
{{- end }}
