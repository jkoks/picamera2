# IFC ITO Studio

Browserapplicatie voor hoeveelhedenbepaling uit IFC-modellen, vergelijkbaar met de
ITO-functie (Information Take-Off) van Solibri. Elementen classificeer je met eigen regels,
je stelt zelf ITO's (hoeveelhedenstaten) samen, en je exporteert die naar Excel.

Er is geen installatie of server nodig. Het IFC-bestand wordt lokaal in de browser ingelezen
en nergens geüpload.

## Starten

Open `index.html` in een moderne browser (Chrome, Edge of Firefox). Je kunt het bestand
dubbelklikken of de map serveren, bijvoorbeeld:

```bash
cd ifc-ito && python3 -m http.server 8000   # daarna http://localhost:8000
```

Bij het opstarten wordt een demo-model geladen (*Demo Kantoor De Linde*: 2 bouwlagen,
wanden, vloeren, kolommen, liggers, kozijnen en ruimten, met NL-SfB-codes). Via **IFC openen**
of door een bestand op het venster te slepen laad je je eigen model.

## Functies

| Onderdeel | Wat het doet |
|---|---|
| **Model** | Ruimtelijke boom (bouwlaag → entiteit), lijst per entiteit, en zoeken op naam, GlobalId, type of tag. |
| **Filters** | Regels op alle IFC-informatie: attributen, property sets, quantity sets, type, materiaal(lagen), bouwlaag, classificatie en berekende geometrie. Operatoren: `=` (met wildcards `*` en `?`), `≠`, bevat, begint met, één van (`a; b; c`), `> ≥ < ≤`, regex, heeft wel/geen waarde. Combineren met *alle* (EN) of *één van* (OF), en filters kunnen naar andere filters verwijzen. |
| **Classificatie** | Eigen schema's met klassen (code, omschrijving, kleur, regels). De eerste klasse die past wint. Handmatige toewijzing per element (ook voor een meervoudige selectie) gaat altijd voor en wordt per GlobalId bewaard, zodat die een nieuwe modelversie overleeft. Je kunt klassen genereren uit de unieke waarden van een eigenschap en het 3D-model per klasse inkleuren. |
| **ITO's** | Zelf samen te stellen staten. Je kiest de scope (filter en/of classificatie), *gegroepeerd* of *per element*, en kolommen met een IFC-veld of een formule. Per kolom stel je de samenvatting in (groeperen, som, aantal, gemiddelde, min, max, unieke waarden, eerste), plus factor (bijv. 0,001 voor mm → m) en decimalen. Klik op een regel om de elementen in 3D en in de eigenschappen te zien. |
| **Formules** | `{Kolomnaam}` verwijst naar een andere kolom, `[Pset::Eigenschap]` naar een IFC-veld. Functies: `round(x; n)`, `ceil`, `floor`, `min`, `max`, `abs`, `sqrt`, `if(voorwaarde; a; b)`. Voorbeeld: `{Volume (m³)} * 95` voor kg wapening. |
| **3D** | three.js + web-ifc. Selecteren met klikken (Ctrl/Shift voor meer), isoleren van de actieve set, overige elementen transparant, en inkleuren op classificatie. |
| **Berekende geometrie** | Uit de getrianguleerde geometrie per element: volume, totaal oppervlak, bovenaanzicht en bounding box (in m, m², m³). Handig als het model geen `Qto_*BaseQuantities` heeft. |
| **Excel** | Een `.xlsx` met een overzichtsblad en per ITO een werkblad: opgemaakte kop, getalnotatie, autofilter, vastgezette kop en een totaalregel met `SUBTOTAAL`-formules, zodat de totalen kloppen als je in Excel filtert. Optioneel komt er per ITO een elementenblad bij. |
| **Configuratie** | Filters, classificaties en ITO's worden automatisch in de browser bewaard. Met **Configuratie opslaan/laden** wissel je ze als JSON uit, bijvoorbeeld als bedrijfsstandaard. |

### Veldnamen

Elk element krijgt een vlakke lijst velden in de vorm `Groep::Naam`:

- `Attribuut::Entiteit`, `Naam`, `GlobalId`, `ObjectType`, `Tag`, `PredefinedType`, `OverallWidth/Height`
- `Locatie::Bouwlaag`, `Gebouw`, `Ruimte`, `Onderdeel van`
- `Type::Typenaam`, `Type-entiteit`
- `Materiaal::Materiaal`, `Materiaalset`, `Laag n`, `Laag n dikte`, `Totale laagdikte`
- `Classificatie::<systeem>` (bijv. `Classificatie::NL-SfB`) en `… omschrijving`
- `<Pset-naam>::<eigenschap>` en `<Qto-naam>::<hoeveelheid>`; property sets van het type worden overgeërfd
- `ITO-classificatie::<schema>`: het resultaat van je eigen classificatie
- `Geometrie (berekend)::…`

Hoeveelheden uit quantity sets staan in de projecteenheden van het model (vaak mm, m², m³).
Gebruik de kolomfactor om om te rekenen.

## Opbouw

```
ifc-ito/
├── index.html          layout en stijl
├── js/ifc-parser.js    eigen STEP/IFC-parser (IFC2x3, IFC4, IFC4x3), zonder afhankelijkheden
├── js/engine.js        filters, classificatie, formules, ITO-berekening en standaardsjablonen
├── js/excel.js         Excel-export (ExcelJS)
├── js/viewer.js        3D-viewer en geometrische hoeveelheden (three.js + web-ifc)
├── js/demo-model.js    generator voor het demo-IFC-model
├── js/app.js           gebruikersinterface
└── tests/run-tests.js  tests van parser en rekenkern: `node ifc-ito/tests/run-tests.js`
```

De parser en de rekenkern werken zonder externe bibliotheken. Alleen voor 3D (three.js 0.147,
web-ifc 0.0.74) en de Excel-export (ExcelJS 4.4) laadt de browser bibliotheken van een CDN.
Zonder internet werken filteren, classificeren en de ITO-tabellen dus nog steeds.

## Beperkingen en ideeën

- Openingen (`IfcOpeningElement`) worden niet van de berekende geometrie afgetrokken als het
  model `IfcRelVoidsElement` gebruikt. web-ifc doet dat meestal wel, maar controleer netto
  hoeveelheden altijd met de `Qto`-waarden uit het model.
- Erg grote modellen (honderden MB) lezen wel in, maar de 3D-weergave wordt dan traag.
- Mogelijke uitbreidingen: meerdere modellen tegelijk (bouwkundig + constructief), een
  vergelijking tussen modelversies op GlobalId, en een koppeling met STABU- of
  begrotingscodes.
