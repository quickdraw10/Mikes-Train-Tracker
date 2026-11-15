// The main lines drawn on the Network tab and the main-line routes on the Route tab.
// Plain data, shared by the app and the server (the server checks each line with /api/lines-check).
// Every station a train might report at between two listed stations counts towards that stretch;
// the in-between stations listed here just keep the drawing close to the real route.

const line = (id, name, codes) => ({ id, name, crs: codes.split(' ') });
export const LINES = [
  line('ecml', 'East Coast Main Line', 'KGX SVG HIT BIW SNO HUN PBO GRA NNG RET DON YRK THI NTR DAR DHM NCL MPT ALM BWK DUN EDB'),
  line('abd', 'Edinburgh – Aberdeen', 'EDB INK KDY LEU DEE ARB MTS STN ABD'),
  line('hml', 'Highland Main Line', 'GLQ STG DBL GLE PTH DKD PIT BLA DLW NWR KIN AVM CAG INV'),
  line('ainv', 'Aberdeen – Inverness', 'ABD INR HNT KEH ELG FOR NRN INV'),
  line('kyle', 'Kyle Line', 'INV DIN GVE ACN STC PLK KYL'),
  line('whl', 'West Highland Line', 'GLQ WES DMR DBC HLU GCH ART AUI CNR UTY BRO RAN CRR TUL RYB SBR FTW GLF ARG MLG'),
  line('oban', 'Crianlarich – Oban', 'CNR TYL DAL TAY CON OBN'),
  line('scot', 'Edinburgh – Glasgow', 'EDB FKK GLQ'),
  line('wcml', 'West Coast Main Line', 'EUS WFJ TRI LBZ MKC RUG NUN TAM LTV STA CRE WBQ WGN PRE LAN OXN PNR CAR LOC CRS MTH GLC'),
  line('wbhm', 'West Coast via Birmingham', 'RUG COV BHI BHM WVH STA'),
  line('mcr', 'Crewe – Manchester', 'CRE WML SPT MAN'),
  line('tpe', 'Liverpool – Leeds', 'LIV NLW MAN SYB HUD LDS'),
  line('yrk', 'Leeds – York', 'LDS CRG GRF MIK CHF ULL YRK'),
  line('sca', 'York – Scarborough', 'YRK MLT SEM SCA'),
  line('hull', 'Leeds – Hull', 'MIK SBY HOW GBD BUH HUL'),
  line('hulld', 'Doncaster – Hull', 'DON TNN GOO GBD'),
  line('mml', 'Midland Main Line', 'STP LUT BDM WEL KET MHR LEI LBO EMD DBY CHD SHF'),
  line('mmlnot', 'Midland Main Line – Nottingham', 'EMD BEE NOT'),
  line('xc', 'Cross Country', 'BRI CNM BMV BHM TAM BUT DBY'),
  line('gwml', 'Great Western Main Line', 'PAD SLO RDG DID SWI CPM BTH BRI'),
  line('west', 'Bristol – Penzance', 'BRI WSM TAU TVP EXD NTA PLY BOD TRU RED SER PNZ'),
  line('bh', 'Reading – Taunton (Berks & Hants)', 'RDG NBY PEW WSB CLC TAU'),
  line('swales', 'South Wales Main Line', 'SWI BPW NWP CDF BGN PTA NTH SWA'),
  line('geml', 'Great Eastern Main Line', 'LST SRA CHM COL IPS DIS NRW'),
  line('hs1', 'High Speed 1', 'STP SFA EBD AFK'),
  line('swml', 'South Western Main Line', 'WAT CLJ WOK BSK WIN SOU BMH'),
  line('bml', 'Brighton Main Line', 'VIC CLJ ECR GTW HHE BTN')
];

const preset = (id, name, codes) => ({ id, name, crs: codes.split(' ') });
export const PRESETS = [
  preset('ecml', 'East Coast Main Line', 'KGX SVG HIT BIW SNO HUN PBO GRA NNG RET DON YRK THI NTR DAR DHM NCL MPT ALM BWK DUN EDB'),
  preset('wcml', 'West Coast Main Line', 'EUS WFJ TRI LBZ MKC RUG NUN TAM LTV STA CRE WBQ WGN PRE LAN OXN PNR CAR LOC CRS MTH GLC'),
  preset('mml', 'Midland Main Line', 'STP LUT BDM WEL KET MHR LEI LBO EMD DBY CHD SHF'),
  preset('mml-not', 'Midland Main Line – Nottingham', 'STP LUT BDM WEL KET MHR LEI LBO EMD BEE NOT'),
  preset('gwml', 'Great Western Main Line', 'PAD SLO RDG DID SWI CPM BTH BRI'),
  preset('bml', 'Brighton Main Line', 'VIC CLJ ECR GTW HHE BTN'),
  preset('yrk-lds', 'York – Leeds', 'YRK ULL CHF MIK GRF CRG LDS'),
  preset('yrk-sca', 'York – Scarborough', 'YRK MLT SEM SCA'),
  preset('lds-hul', 'Leeds – Hull', 'LDS CRG GRF MIK SBY HOW GBD BUH HUL'),
  preset('bri-pnz', 'Bristol – Penzance', 'BRI WSM TAU TVP EXD NTA PLY BOD TRU RED SER PNZ')
];
