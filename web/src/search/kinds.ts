import type { PlaceCategory } from './placeIndex'

/**
 * What a search result is called, in the rider's words rather than the schema's.
 *
 * Protomaps' `kind` is a tagging vocabulary, not a label: `locality`, `place_of_worship`,
 * `minor_road`, `social_facility`. Shown raw it reads as debug output, and half of it is
 * actively misleading — a `locality` is a town, and a rider does not know that.
 *
 * So there is a table, and it is deliberately shallow: the common two hundred kinds collapse
 * into about thirty words a rider already uses, and anything the table has never heard of falls
 * back to its category. An unknown kind should read as *Place* and not as `bureau_de_change`;
 * the fallback is the interesting half of this file.
 */

const LABELS: Record<string, string> = {
  // places
  locality: 'Town or village',
  neighbourhood: 'Neighbourhood',
  macrohood: 'Area',
  borough: 'Borough',
  suburb: 'Suburb',
  quarter: 'Quarter',
  hamlet: 'Hamlet',
  village: 'Village',
  town: 'Town',
  city: 'City',
  island: 'Island',
  continent: 'Continent',
  country: 'Country',
  region: 'Region',

  // roads
  major_road: 'Main road',
  minor_road: 'Street',
  highway: 'Motorway',
  path: 'Path or cycleway',
  other: 'Track',

  // water
  river: 'River',
  stream: 'Burn or stream',
  canal: 'Canal',
  lake: 'Loch or lake',
  water: 'Water',
  reservoir: 'Reservoir',
  bay: 'Bay',
  ocean: 'Sea',
  sea: 'Sea',

  // the points of interest worth naming by hand
  peak: 'Hill or peak',
  park: 'Park',
  nature_reserve: 'Nature reserve',
  forest: 'Forest',
  wood: 'Wood',
  garden: 'Garden',
  pub: 'Pub',
  bar: 'Bar',
  cafe: 'Café',
  restaurant: 'Restaurant',
  fast_food: 'Takeaway',
  bakery: 'Bakery',
  supermarket: 'Supermarket',
  convenience: 'Shop',
  bicycle: 'Bike shop',
  car_repair: 'Garage',
  fuel: 'Petrol station',
  hotel: 'Hotel',
  hostel: 'Hostel',
  camp_site: 'Campsite',
  caravan_site: 'Caravan site',
  station: 'Station',
  bus_station: 'Bus station',
  ferry_terminal: 'Ferry terminal',
  parking: 'Car park',
  bicycle_parking: 'Bike parking',
  toilets: 'Toilets',
  drinking_water: 'Drinking water',
  hospital: 'Hospital',
  doctors: 'Doctors',
  pharmacy: 'Pharmacy',
  school: 'School',
  university: 'University',
  college: 'College',
  library: 'Library',
  museum: 'Museum',
  attraction: 'Attraction',
  viewpoint: 'Viewpoint',
  castle: 'Castle',
  ruins: 'Ruins',
  archaeological_site: 'Historic site',
  monument: 'Monument',
  memorial: 'Memorial',
  place_of_worship: 'Church',
  cemetery: 'Cemetery',
  grave_yard: 'Graveyard',
  sports_centre: 'Sports centre',
  swimming_pool: 'Swimming pool',
  golf_course: 'Golf course',
  pitch: 'Playing field',
  recreation_ground: 'Recreation ground',
  beach: 'Beach',
  marina: 'Marina',
  community_centre: 'Community centre',
  post_office: 'Post office',
  townhall: 'Town hall',
  farmyard: 'Farm',
  farmland: 'Farmland',
  quarry: 'Quarry',
  industrial: 'Industrial estate',
  retail: 'Retail park',
  commercial: 'Business park',
  residential: 'Housing',
  allotments: 'Allotments',
  golf: 'Golf course',
  airport: 'Airport',
  aerodrome: 'Airfield',
}

const FALLBACK: Record<PlaceCategory, string> = {
  place: 'Place',
  road: 'Street',
  water: 'Water',
  poi: 'Place',
}

/** The words under a result's name. Never a raw schema token. */
export function kindLabel(category: PlaceCategory, kind: string): string {
  return LABELS[kind] ?? FALLBACK[category]
}

/**
 * Which of five glyphs a result gets.
 *
 * Five, not thirty. A row is identified by its name and the words under it; the glyph exists to
 * tell a street from a town at a glance in a list, and thirty little pictures at 20px is
 * decoration a rider has to learn. Anything not obviously one of the other four is a pin.
 */
export type PlaceGlyph = 'town' | 'street' | 'water' | 'hill' | 'pin'

const HILLS = new Set(['peak', 'volcano', 'ridge', 'saddle', 'cliff', 'valley', 'glacier'])

export function placeGlyph(category: PlaceCategory, kind: string): PlaceGlyph {
  if (category === 'road') return 'street'
  if (category === 'water') return 'water'
  if (category === 'place') return 'town'
  if (HILLS.has(kind)) return 'hill'
  return 'pin'
}
