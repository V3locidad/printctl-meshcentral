#!/usr/bin/env python3
"""
Query / purge Win32_PrintJob on a Windows print server via WMI (impacket).

Usage:
  wmi_print_jobs.py list   HOST USER PASS DOMAIN [PRINTER]
  wmi_print_jobs.py purge  HOST USER PASS DOMAIN PRINTER

Outputs a single JSON line on stdout: {"jobs": [...]} or {"deleted": N} or {"error": "..."}.
"""

import sys
import json
import traceback


def emit(payload):
    sys.stdout.write(json.dumps(payload))
    sys.stdout.write('\n')


def main():
    if len(sys.argv) < 6:
        emit({"error": "usage: <list|purge> HOST USER PASS DOMAIN [PRINTER]"})
        sys.exit(2)
    mode = sys.argv[1]
    host, user, password, domain = sys.argv[2:6]
    printer_filter = (sys.argv[6] if len(sys.argv) > 6 else '').strip()

    if mode == 'purge' and not printer_filter:
        emit({"error": "purge requires a printer name"})
        sys.exit(2)

    try:
        from impacket.dcerpc.v5.dcomrt import DCOMConnection
        from impacket.dcerpc.v5.dcom import wmi
        from impacket.dcerpc.v5.dtypes import NULL
    except Exception as e:
        emit({"error": "impacket missing: " + str(e)})
        sys.exit(1)

    dcom = None
    try:
        dcom = DCOMConnection(host, user, password, domain, '', '', oxidResolver=True)
        iInterface = dcom.CoCreateInstanceEx(wmi.CLSID_WbemLevel1Login, wmi.IID_IWbemLevel1Login)
        iWbemLevel1Login = wmi.IWbemLevel1Login(iInterface)
        iWbemServices = iWbemLevel1Login.NTLMLogin('//./root/cimv2', NULL, NULL)
        iWbemLevel1Login.RemRelease()

        # SELECT * is intentional: SELECT-with-columns omits system properties like
        # __PATH__, which we need to delete instances via IWbemServices.DeleteInstance.
        wql = "SELECT * FROM Win32_PrintJob"
        iEnum = iWbemServices.ExecQuery(wql)

        def g(rec, k):
            v = rec.get(k, {})
            if isinstance(v, dict):
                v = v.get('value', '')
            return '' if v is None else str(v)

        jobs = []
        target_paths = []
        while True:
            try:
                pEnum = iEnum.Next(0xffffffff, 1)[0]
            except Exception:
                break
            rec = pEnum.getProperties()
            name = g(rec, 'Name')  # "PrinterShortName, JobId"
            if printer_filter and printer_filter.lower() not in name.lower():
                continue

            jobs.append({
                "jobid": g(rec, 'JobId'),
                "document": g(rec, 'Document'),
                "owner": g(rec, 'Owner'),
                "jobstatus": g(rec, 'JobStatus'),
                "status": g(rec, 'Status'),
                "pagesprinted": g(rec, 'PagesPrinted'),
                "totalpages": g(rec, 'TotalPages'),
                "size": g(rec, 'Size'),
                "submitted": g(rec, 'TimeSubmitted'),
                "name": name,
            })
            if mode == 'purge':
                # Try the system __PATH__ first; if impacket didn't surface it,
                # build a relative path from the Name key, which uniquely
                # identifies a Win32_PrintJob instance ("Printer, JobId").
                path = g(rec, '__PATH__') or g(rec, '__RELPATH__')
                if not path and name:
                    escaped = name.replace('\\', '\\\\').replace('"', '\\"')
                    path = 'Win32_PrintJob.Name="' + escaped + '"'
                if path:
                    target_paths.append(path)

        if mode == 'list':
            emit({"jobs": jobs})
            return

        deleted = 0
        failed = []
        for path in target_paths:
            try:
                iWbemServices.DeleteInstance(path)
                deleted += 1
            except Exception as e:
                failed.append({"path": path, "error": str(e)})
        # Also surface the matched job count and the paths we built so the UI can
        # explain "0 deleted" when there was nothing to match in the first place.
        emit({
            "deleted": deleted,
            "failed": len(failed),
            "errors": failed[:5],
            "matched": len(jobs),
            "paths": target_paths[:5],
        })

    except Exception as e:
        emit({"error": str(e), "trace": traceback.format_exc().splitlines()[-1]})
        sys.exit(1)
    finally:
        if dcom is not None:
            try:
                dcom.disconnect()
            except Exception:
                pass


if __name__ == '__main__':
    main()
