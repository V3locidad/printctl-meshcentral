#!/usr/bin/env python3
"""
Query Win32_PrintJob on a Windows print server via WMI (impacket).
Usage: wmi_print_jobs.py HOST USER PASSWORD DOMAIN [PRINTER_NAME_FILTER]
Outputs a JSON line: {"jobs": [...]} or {"error": "..."}.
"""

import sys
import json
import traceback

def emit(payload):
    sys.stdout.write(json.dumps(payload))
    sys.stdout.write('\n')

def main():
    if len(sys.argv) < 5:
        emit({"error": "usage: HOST USER PASSWORD DOMAIN [PRINTER]"})
        sys.exit(2)
    host, user, password, domain = sys.argv[1:5]
    printer_filter = (sys.argv[5] if len(sys.argv) > 5 else '').strip()

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

        wql = ("SELECT JobId, Document, Owner, JobStatus, Status, PagesPrinted, "
               "TotalPages, Size, TimeSubmitted, Name FROM Win32_PrintJob")
        iEnum = iWbemServices.ExecQuery(wql)

        jobs = []
        while True:
            try:
                pEnum = iEnum.Next(0xffffffff, 1)[0]
            except Exception:
                break
            rec = pEnum.getProperties()
            def g(k):
                v = rec.get(k, {})
                if isinstance(v, dict):
                    v = v.get('value', '')
                return '' if v is None else str(v)

            name = g('Name')  # "PrinterName, JobId"
            if printer_filter and printer_filter.lower() not in name.lower():
                continue

            jobs.append({
                "jobid": g('JobId'),
                "document": g('Document'),
                "owner": g('Owner'),
                "jobstatus": g('JobStatus'),
                "status": g('Status'),
                "pagesprinted": g('PagesPrinted'),
                "totalpages": g('TotalPages'),
                "size": g('Size'),
                "submitted": g('TimeSubmitted'),
                "name": name,
            })

        emit({"jobs": jobs})
    except Exception as e:
        emit({"error": str(e), "trace": traceback.format_exc().splitlines()[-1]})
        sys.exit(1)
    finally:
        if dcom is not None:
            try: dcom.disconnect()
            except Exception: pass

if __name__ == '__main__':
    main()
