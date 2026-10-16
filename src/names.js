import crypto from 'node:crypto';

const ADJECTIVES = [
  'brave', 'calm', 'cosmic', 'cozy', 'crisp', 'dapper', 'eager', 'fancy', 'fluffy', 'fuzzy',
  'gentle', 'giddy', 'glowing', 'golden', 'happy', 'jolly', 'lucky', 'mellow', 'merry', 'misty',
  'nimble', 'peppy', 'plucky', 'quick', 'quiet', 'rapid', 'rosy', 'shiny', 'silly', 'sleepy',
  'snappy', 'sparkly', 'speedy', 'spicy', 'sunny', 'swift', 'tidy', 'tiny', 'velvet', 'witty',
  'zesty', 'zippy', 'bouncy', 'breezy', 'bubbly', 'cheeky', 'chill', 'clever', 'dreamy', 'electric',
  'frosty', 'funky', 'groovy', 'hyper', 'lunar', 'magic', 'neon', 'pixel', 'polar', 'retro',
  'solar', 'stellar', 'turbo', 'wild',
];

const NOUNS = [
  'otter', 'panda', 'falcon', 'koala', 'lemur', 'llama', 'narwhal', 'octopus', 'penguin', 'puffin',
  'quokka', 'raccoon', 'sloth', 'tiger', 'walrus', 'yak', 'badger', 'beaver', 'bison', 'capybara',
  'cheetah', 'dolphin', 'ferret', 'gecko', 'hedgehog', 'heron', 'ibis', 'jaguar', 'kiwi', 'lynx',
  'mantis', 'marmot', 'moose', 'newt', 'ocelot', 'owl', 'pelican', 'phoenix', 'pony', 'rabbit',
  'robin', 'salmon', 'seal', 'shark', 'sparrow', 'squid', 'stork', 'swan', 'tapir', 'toucan',
  'turtle', 'unicorn', 'viper', 'wombat', 'zebra', 'comet', 'nebula', 'rocket', 'meteor', 'nova',
  'cloud', 'breeze', 'pebble', 'waffle',
];

const ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';

function pick(list) {
  return list[crypto.randomInt(list.length)];
}

/** e.g. "sunny-otter-x7k2" — friendly, but ~1.6e10 possibilities so not guessable. */
export function generateName() {
  let suffix = '';
  for (let i = 0; i < 4; i++) suffix += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return `${pick(ADJECTIVES)}-${pick(NOUNS)}-${suffix}`;
}

export function randomToken(bytes = 18) {
  return crypto.randomBytes(bytes).toString('base64url');
}

const RESERVED = new Set(['www', 'api', 'app', 'admin', 'relay', 'mail', 'status', 'docs', 'dashboard', 'localcloud', '_acme-challenge']);

/** Normalise a user supplied tunnel name. Returns null when it cannot be used. */
export function normalizeName(name) {
  if (typeof name !== 'string') return null;
  const n = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/, '');
  if (!n || RESERVED.has(n)) return null;
  return n;
}
