"""Validate the draft, its examples and important invalid wire representations.

This validates a design artifact, not a running Provider or the OfficeCLI API.
Install requirements.txt in a separate development venv; no service is started.
"""

from copy import deepcopy
from pathlib import Path
import json

import yaml
from jsonschema import Draft202012Validator, FormatChecker
from openapi_spec_validator import validate_spec


def main():
    path = Path(__file__).with_name("officecli-provider-v1.openapi.yaml")
    spec = yaml.safe_load(path.read_text(encoding="utf-8"))
    validate_spec(spec)
    schemas = spec["components"]["schemas"]
    checker = FormatChecker()

    def validator(name):
        return Draft202012Validator(
            {
                "$ref": f"#/components/schemas/{name}",
                "components": spec["components"],
            },
            format_checker=checker,
        )

    examples = 0
    for name, schema in schemas.items():
        for example in schema.get("examples", []):
            validator(name).validate(example)
            examples += 1

    publication_id = "40c1fb9f-a4c1-4e42-9270-161049083771"
    context = {
        "tenantId": "acme",
        "appId": "archive",
        "sessionId": "0d0767af-3d33-4fc5-84a0-84f4c00ff159",
        "actorId": "user-7",
    }
    intent = deepcopy(schemas["PublicationIntent"]["examples"][0])
    prepare = {"context": context, "intent": intent}
    receipt = {
        "publicationId": publication_id,
        "externalFileId": "contract-42",
        "documentId": "hcd-contract-42",
        "revision": 7,
        "externalVersion": "file-v20",
        "sha256": "a" * 64,
        "committedAt": "2026-11-15T06:01:00Z",
    }
    committed = {
        "publicationId": publication_id,
        "state": "committed",
        "receipt": receipt,
    }
    event = {
        "schemaVersion": "officecli-event/1",
        "eventId": "f7895bdd-038f-4893-9b04-cc13e5f7a0f9",
        "tenantId": "acme",
        "appId": "archive",
        "externalFileId": "contract-42",
        "documentId": "hcd-contract-42",
        "sequence": 8,
        "occurredAt": "2026-11-15T06:01:01Z",
        "type": "publication.committed",
        "payload": {"receipt": receipt},
    }
    cases = []

    def case(name, schema, value, valid=True):
        cases.append((name, schema, value, valid))

    case("publication intent", "PrepareRequest", prepare)
    case("durable receipt", "PublicationReceipt", receipt)
    case("committed status", "PublicationStatus", committed)
    case("unknown outcome", "PublicationStatus", {
        "publicationId": publication_id, "state": "unknown",
    })
    case("commit request", "CommitRequest", {
        "context": context, "publicationId": publication_id, "uploadId": "stage-1",
    })
    case("committed event", "Event", event)
    case("read-only grant", "PermissionDecision", {
        "granted": ["document.view"], "permissionVersion": "acl-13",
        "expiresAt": "2026-11-15T06:02:00Z",
        "constraints": {"exportFormats": [], "modelIds": []},
    })

    for kind, payload in [
        ("document.imported", {"revision": 0}),
        ("revision.committed", {"revision": 8}),
        ("publication.failed", {"publicationId": publication_id, "errorCode": "VERSION_CONFLICT"}),
        ("export.completed", {"jobId": "export-1", "revision": 7}),
        ("agent.run.changed", {"runId": "run-1", "state": "interrupted"}),
        ("session.closed", {"sessionId": context["sessionId"]}),
    ]:
        value = {**event, "type": kind, "payload": payload}
        case(f"{kind} payload", "Event", value)
        case(f"{kind} missing payload", "Event", {**value, "payload": {}}, False)

    case("commit cannot omit receipt", "PublicationStatus", {
        "publicationId": publication_id, "state": "committed",
    }, False)
    case("unknown cannot claim a receipt", "PublicationStatus", {
        **committed, "state": "unknown",
    }, False)
    case("upload is not commitment", "PublicationStatus", {
        "publicationId": publication_id, "state": "uploaded",
    }, False)
    case("committed event needs receipt", "Event", {**event, "payload": {}}, False)
    case("event rejects token field", "Event", {
        **event, "payload": {"receipt": receipt, "token": "illustrative-forbidden-field"},
    }, False)
    case("event cannot claim another protocol", "Event", {
        **event, "schemaVersion": "officecli-event/2",
    }, False)
    case("event sequence starts at one", "Event", {**event, "sequence": 0}, False)
    case("timestamps have date-time format", "Event", {**event, "occurredAt": "yesterday"}, False)
    case("receipt rejects invalid publication ID", "PublicationReceipt", {
        **receipt, "publicationId": "not-a-uuid",
    }, False)
    case("receipt rejects negative revision", "PublicationReceipt", {**receipt, "revision": -1}, False)

    no_cas = deepcopy(prepare)
    no_cas["intent"]["expectedVersion"] = ""
    case("CAS version cannot be empty", "PrepareRequest", no_cas, False)
    wrong_hash = deepcopy(prepare)
    wrong_hash["intent"]["output"]["sha256"] = "sha256:" + "a" * 64
    case("file hash has exact encoding", "PrepareRequest", wrong_hash, False)
    case("unknown operation is rejected", "PermissionQuery", {
        "context": context, "externalFileId": "contract-42", "operations": ["admin.all"],
    }, False)
    case("context rejects arbitrary identity fields", "Context", {
        **context, "isAdmin": True,
    }, False)

    failures = []
    for name, schema, value, expected in cases:
        errors = list(validator(schema).iter_errors(value))
        if (not errors) != expected:
            failures.append({"case": name, "errors": [e.message for e in errors]})
    if failures:
        raise AssertionError(json.dumps(failures, ensure_ascii=False, indent=2))

    print(json.dumps({
        "status": "passed",
        "scope": "draft-contract-only",
        "openapi": spec["openapi"],
        "paths": len(spec["paths"]),
        "schemas": len(schemas),
        "embeddedExamples": examples,
        "validCases": sum(expected for _, _, _, expected in cases),
        "rejectedCases": sum(not expected for _, _, _, expected in cases),
        "runtimeVerified": False,
    }, indent=2))


if __name__ == "__main__":
    main()
