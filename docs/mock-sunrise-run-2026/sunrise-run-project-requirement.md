# Project Requirement RQ-2026-1213: Marina Bay Sunrise Run 2026

**Requested by:** Marina Bay Sunrise Run Organising Committee (event organiser, fictional)
**Prepared for:** Network Operations & Bus Services
**Date issued:** 10/11/2026
**Effective period:** 13/12/2026 03:00 to 13/12/2026 11:30 (temporary)

> Mock-up for testing document upload in BRASS. The event, organiser and contacts are fictional; the roads, stops and buses are the ones on the BRASS map.

## 1. Summary
The Marina Bay Sunrise Run 2026 (21.1 km, 10 km and 5 km) will close Downtown Avenue 4 between Marina View and Esplanade Dr (Dir 1) on Sunday 13 December 2026, from 03:00 until the last runner finishes and the course is cleared at 11:30. Bus services through the event zone must be diverted and four stops on the course will be closed.

A free race-day shuttle, new bus service 13R, will run around the event zone (section 7).

## 2. Race-day schedule
| Time | Activity |
|------|----------|
| 03:00 | Road closures begin; course set-up |
| 04:00 | Race village opens at Esplanade Dr |
| 04:30 | Shuttle 13R starts |
| 05:00 | Flag-off: 21.1 km |
| 06:15 | Flag-off: 10 km |
| 07:30 | Flag-off: 5 km |
| 10:30 | Last runners finish |
| 11:30 | Course cleared; roads reopen |

## 3. Road closure
- **Road:** Downtown Avenue 4, between Marina View (01012) and Esplanade Dr (Dir 1) (01037).
- **Closure:** both directions, full closure, 03:00 to 11:30.
- **Reason:** Marina Bay Sunrise Run 2026 course and race village.

## 4. Affected area (Polygon Import)
Event zone covering roughly 400 m around Downtown Avenue 4, as drawn in `sunrise-run-affected-area.json`. Every road inside the zone is closed to general traffic and buses during the effective period; only race and emergency vehicles may enter.

## 5. Affected services
| Bus | Change |
|-----|--------|
| 387 | Divert around the event zone. Skip Marina View (01012) and Marina Bay Stn (01013). |
| 702 | Divert around the event zone. Skip Marina View (01012), Marina Bay Stn (01013) and Esplanade Dr (Dir 1) (01037). |
| 966 | Divert around the event zone. Skip Marina Bay Stn (01013), Esplanade Dr (Dir 1) (01037) and Ocean Financial Ctr (Dir 1) (01056). |
| 125 | Divert around the event zone. Skip Marina Bay Stn (01013) and Ocean Financial Ctr (Dir 1) (01056). |
| 401 | Divert around the event zone. Skip Marina Bay Stn (01013). |
| 788 | Divert around the event zone. Skip Marina Bay Stn (01013). |
| 654 | Divert around the event zone. Skip Marina View (01012). |
| 283 | Divert around the event zone. |
| 715 | Divert around the event zone. |
| 471 | Divert around the event zone. |

## 6. Stops
| Stop | Code | Status |
|------|------|--------|
| Marina View | 01012 | Closed 03:00 to 11:30. Use Shenton Way (Dir 1) (01061). |
| Esplanade Dr (Dir 1) | 01037 | Closed 03:00 to 11:30. Use Suntec Twr 3 (Dir 1) (01035). |
| Marina Bay Stn | 01013 | Closed 03:00 to 11:30. Use One Raffles Quay (Dir 1) (01101). |
| Ocean Financial Ctr (Dir 1) | 01056 | Closed 03:00 to 11:30. Use Bayfront Ave (Dir 2) (01050). |
| Shenton Way (Dir 1) | 01061 | Open. Temporary pick-up for riders from Marina View. |
| Suntec Twr 3 (Dir 1) | 01035 | Open. Temporary pick-up for riders from Esplanade Dr. |
| One Raffles Quay (Dir 1) | 01101 | Open. Temporary pick-up for riders from Marina Bay Stn. |
| Bayfront Ave (Dir 2) | 01050 | Open. Temporary pick-up for riders from Ocean Financial Ctr. |

## 7. Race-day shuttle: new bus service 13R
A free race-day shuttle, new bus service 13R, will link Downtown Interchange and Tanjong Pagar Interchange around the event zone for runners and spectators.

| Stop | Code |
|------|------|
| Downtown Int | 01001 |
| Bayfront Ave (Dir 2) | 01050 |
| One Raffles Quay (Dir 1) | 01101 |
| Aft Tanjong Pagar St 72 | 07023 |
| Bef Tanjong Pagar St 92 | 07030 |
| Tanjong Pagar Stn (Dir 2) | 07024 |
| Downtown Stn (Dir 2) | 07031 |
| Aft Tanjong Pagar St 91 | 07048 |
| Tanjong Pagar Int | 07001 |

- **Operating hours:** 04:30 to 12:00 on 13/12/2026 only.
- **Frequency:** every 10 minutes.

## 8. Required map updates
1. Import the event zone from `sunrise-run-affected-area.json`.
2. Add a road closure on Downtown Avenue 4 between 01012 and 01037 for the effective period.
3. Mark stops 01012, 01037, 01013 and 01056 as not served for the period.
4. Add new bus service 13R with stops 01001, 01050, 01101, 07023, 07030, 07024, 07031, 07048 and 07001 in order.
5. Re-route bus services 387, 702, 966, 125, 401, 788, 654, 283, 715 and 471 around the event zone.

## 9. Contact
Race Operations Desk (fictional), 6000 1213, raceops@example.com
