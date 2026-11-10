# Overall Project Requirement RQ-2026-0501: Bishan Avenue 4 Corridor Works & Service Plan

**Requested by:** Land Transport Authority, Network Operations & Bus Services
**Date issued:** 04/11/2026
**Effective period:** 01/12/2026 22:00 to 14/12/2026 05:00 (temporary)

## 1. Summary
Water main replacement and corridor works will fully close Bishan Avenue 4 between the Library (Dir 2) stop and the Bishan Community Club (Dir 2) stop. All bus services operating along this stretch must be diverted around the affected area, two stops on the closed stretch will be suspended, and a new shuttle bus service 12B will be introduced. Planners must also review road segment constraints along each route segment and verify stop locations via Google Street View.

## 2. Road closure
- **Road:** Bishan Avenue 4, between Library (Dir 2) (53097) and Bishan Community Club (Dir 2) (53148).
- **Closure:** both directions, full closure, 24 hours a day.
- **Reason:** water main replacement, utility trenching and road reinstatement.

## 3. Affected area (Polygon Import)
Works zone polygon along Bishan Avenue 4, as drawn and imported from `affected-area-polygon.json`. No public buses or unauthorized vehicles are permitted inside the polygon boundary during the effective period.

## 4. Affected services
| Bus | Change |
|-----|--------|
| 84  | Divert around the closure. Skip Opp Blk 735 (53082). |
| 518 | Divert around the closure. Skip Opp Blk 735 (53082). |
| 406 | Divert around the closure. Skip Bishan Market & Food Ctr (Dir 2) (53030). |
| 430 | Divert around the closure. Skip Bishan Market & Food Ctr (Dir 2) (53030). |
| 479 | Divert around the closure. Skip Bishan Market & Food Ctr (Dir 2) (53030). |
| 67  | Divert around the closure. |
| 91  | Divert around the closure. |
| 242 | Divert around the closure. |
| 272 | Divert around the closure. |
| 327 | Divert around the closure. |
| 413 | Divert around the closure. |
| 595 | Divert around the closure. |
| 817 | Divert around the closure. |
| 881 | Divert around the closure. |
| 939 | Divert around the closure. |

## 5. Stops
| Stop | Code | Status |
|------|------|--------|
| Opp Blk 735 | 53082 | Closed for the period. Use Library (Dir 2) (53097). |
| Bishan Market & Food Ctr (Dir 2) | 53030 | Closed for the period. Use Bishan Community Club (Dir 2) (53148). |
| Library (Dir 2) | 53097 | Open. Temporary pick-up for riders from Opp Blk 735. |
| Bishan Community Club (Dir 2) | 53148 | Open. Temporary pick-up for riders from Bishan Market & Food Ctr. |

## 6. New bus service 12B
A new bus service 12B will link Bishan Interchange with Bishan Shopping Centre via Bishan Road and Bishan Street 62 to serve commuters while Bishan Avenue 4 is closed.

| Stop | Code |
|------|------|
| Bishan Int | 53001 |
| Bishan Polyclinic | 53003 |
| Bef Bishan St 62 | 53048 |
| Opp Blk 853 | 53129 |
| Bishan Shopping Ctr (Dir 1) | 53080 |

- **Operating hours:** 06:00 to 23:00, daily.
- **Frequency:** every 10 to 12 minutes.

## 7. Route Segment Constraints & Street View Verification
1. Inspect each route segment for physical and operational constraints (height clearance, axle weight, narrow lane width, turning radius, school zone speed limits, peak bus-priority windows, and road gradient).
2. Mark each road segment constraint as **Accept** or **Not Accept**; if any constraint is not accepted, reroute the bus to avoid that segment.
3. Verify bus stop kerbside access using the **Google Street View** link provided in each bus stop and bus route info panel.

## 8. Required map updates
1. Import the affected area polygon from `affected-area-polygon.json`.
2. Add a road closure on Bishan Avenue 4 between 53097 and 53148 for the effective period.
3. Mark stops 53082 and 53030 as not served for the period.
4. Add new bus service 12B with stops 53001, 53003, 53048, 53129, and 53080 in order.
5. Re-route all affected bus services around the closure and unaccepted road constraints.
