"""E2E verification of ClickHouse sync via Search API.

Complete end-to-end test:
1. Send spans via OTLP exporter (same as local_versioning_example.py)
2. Wait for ClickHouse sync (polling Search API)
3. Verify data via Search API endpoints

Prerequisites:
1. Start Docker: `cd cloud && docker compose -f docker/compose.yml up -d`
2. Start cloud server: `bun run cloud:dev`
3. Start sync worker: `cd cloud && bun run tsx workers/clickhouseSyncLocal.ts`

Usage:
    MIRASCOPE_API_KEY=mk_xxx uv run python examples/misc/local_clickhouse_verify.py
"""

from __future__ import annotations

import os
import time
from datetime import datetime, timedelta, timezone

from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor

from mirascope import ops
from mirascope.api._generated.search import SearchSearchResponse
from mirascope.api.client import Mirascope, create_export_client
from mirascope.ops._internal.exporters import MirascopeOTLPExporter

BASE_URL = os.getenv("MIRASCOPE_BASE_URL", "http://localhost:3000/api/v0")
API_KEY = os.getenv("MIRASCOPE_API_KEY")


def send_spans(provider: TracerProvider) -> str:
    """Send test spans via OTLP exporter. Returns span name for verification."""

    @ops.trace
    def e2e_clickhouse_test(message: str) -> str:
        """E2E test trace for ClickHouse verification."""
        return f"processed: {message}"

    @ops.trace
    def e2e_nested_operation(data: str) -> str:
        """Nested operation to create multi-span trace."""
        return f"nested: {data}"

    # Create a trace with nested spans
    trace = e2e_clickhouse_test.wrapped("ClickHouse E2E test message")
    print(f"    Trace result: {trace.result}")

    nested = e2e_nested_operation.wrapped("nested data")
    print(f"    Nested result: {nested.result}")

    provider.force_flush()
    print("    Spans flushed!")

    return "e2e_clickhouse_test"


def wait_for_sync(client: Mirascope, span_name: str, timeout_sec: int = 30):
    """Poll Search API until spans appear or timeout."""
    now = datetime.now(timezone.utc)
    start_time = (now - timedelta(minutes=5)).isoformat()
    end_time = (now + timedelta(minutes=5)).isoformat()

    for i in range(timeout_sec):
        result = client.search.search(
            start_time=start_time,
            end_time=end_time,
            query=span_name,
            limit=10,
            sort_by="start_time",
            sort_order="desc",
        )
        if result.total and result.total > 0:
            return result
        print(f"    Waiting for sync... ({i + 1}/{timeout_sec}s)")
        time.sleep(1)
    return None


def verify_search_api(client: Mirascope, search_result: SearchSearchResponse) -> bool:
    """Verify Search API endpoints with the synced data."""
    spans = search_result.spans or []
    total = search_result.total or 0
    print(f"    Found {total} spans (showing {len(spans)})")

    for span in spans[:3]:
        dur = span.duration_ms
        dur_str = f"{dur}ms" if dur is not None else "NULL"
        model = span.model or "N/A"
        name = span.name[:30] if span.name else "N/A"
        print(f"      - {name:<30} | {model:<15} | {dur_str}")

    if not spans:
        return False

    trace_id = spans[0].trace_id
    trace_result = client.search.gettracedetail(trace_id)

    if not trace_result:
        print("    Failed to get trace detail")
        return False

    trace_spans = trace_result.spans or []
    print(f"    Trace {trace_id[:16]}... has {len(trace_spans)} spans")

    now = datetime.now(timezone.utc)
    start_time = (now - timedelta(minutes=10)).isoformat()
    end_time = (now + timedelta(minutes=5)).isoformat()

    analytics_result = client.search.getanalyticssummary(
        start_time=start_time,
        end_time=end_time,
    )

    if not analytics_result:
        print("    Failed to get analytics")
        return False

    print(
        f"    Analytics: {analytics_result.total_spans or 0} spans, "
        f"avg {analytics_result.avg_duration_ms}ms"
    )

    return True


def main():
    if not API_KEY:
        print("ERROR: MIRASCOPE_API_KEY environment variable is required")
        print("Create an API key in the Mirascope Cloud UI: http://localhost:3000")
        exit(1)

    print("=" * 70)
    print("ClickHouse E2E Verification")
    print("=" * 70)
    print(f"API Base URL: {BASE_URL}")
    print(f"API Key: {API_KEY[:15]}...")

    # Create Mirascope client for Search API
    api_client = Mirascope(base_url=BASE_URL, api_key=API_KEY)

    # 1. Setup OTLP exporter
    print("\n[1/4] Setting up OTLP exporter...")
    export_client = create_export_client(base_url=BASE_URL, api_key=API_KEY)
    provider = TracerProvider()
    exporter = MirascopeOTLPExporter(client=export_client)
    provider.add_span_processor(BatchSpanProcessor(exporter))
    ops.configure(tracer_provider=provider)
    ops.instrument_llm()
    print("    OTLP exporter configured")

    # 2. Send spans
    print("\n[2/4] Sending test spans...")
    span_name = send_spans(provider)

    # 3. Wait for ClickHouse sync
    print("\n[3/4] Waiting for ClickHouse sync...")
    search_result = wait_for_sync(api_client, span_name)

    if not search_result:
        print("    TIMEOUT: Spans not found in ClickHouse")
        print("    Make sure clickhouseSyncLocal worker is running:")
        print("      cd cloud && bun run tsx workers/clickhouseSyncLocal.ts")
        provider.shutdown()
        exit(1)

    print("    Sync complete!")

    # 4. Verify Search API
    print("\n[4/4] Verifying Search API...")
    success = verify_search_api(api_client, search_result)

    provider.shutdown()

    print("\n" + "=" * 70)
    if success:
        print("E2E Verification PASSED!")
    else:
        print("E2E Verification FAILED!")
        exit(1)
    print("=" * 70)


if __name__ == "__main__":
    main()
