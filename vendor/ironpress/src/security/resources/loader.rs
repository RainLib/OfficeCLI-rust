use std::collections::HashMap;
use std::path::Path;

#[cfg(feature = "remote")]
use std::collections::HashSet;

use crate::util::decode_base64;

use super::{DocumentResources, ResolvedResource};

/// Bytes loaded through the document's local and remote security policy.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LoadedResource {
    pub(crate) bytes: Vec<u8>,
    pub(crate) media_type: Option<String>,
}

/// Conversion-owned resource authority and cache.
#[derive(Debug, Default)]
pub(crate) struct ResourceLoader {
    resources: DocumentResources,
    cache: HashMap<ResolvedResource, CachedResource>,
}

/// Result of one attempted load retained for the whole conversion.
///
/// The cache entry itself proves that the request was attempted. `loaded` is
/// absent when policy, transport, or response limits made it unavailable.
#[derive(Debug, Clone, Default)]
struct CachedResource {
    loaded: Option<LoadedResource>,
}

impl CachedResource {
    fn new(loaded: Option<LoadedResource>) -> Self {
        Self { loaded }
    }

    fn loaded(&self) -> Option<LoadedResource> {
        self.loaded.clone()
    }
}

#[cfg(feature = "remote")]
/// Limit simultaneous connections and response reads for one document.
const MAX_CONCURRENT_REMOTE_FETCHES: usize = 8;

impl ResourceLoader {
    pub(crate) fn new(resources: DocumentResources) -> Self {
        Self {
            resources,
            cache: HashMap::new(),
        }
    }

    pub(crate) fn resources(&self) -> &DocumentResources {
        &self.resources
    }

    pub(crate) fn load(&mut self, reference: &str, base: Option<&Path>) -> Option<LoadedResource> {
        let resource = self.resources.resolve(reference, base)?;
        self.load_resolved(resource)
    }

    pub(crate) fn load_document_resource(&mut self, reference: &str) -> Option<LoadedResource> {
        let base = self.resources.base_path().map(Path::to_path_buf);
        self.load(reference, base.as_deref())
    }

    pub(crate) fn load_resolved(&mut self, resource: ResolvedResource) -> Option<LoadedResource> {
        if let Some(cached) = self.cache.get(&resource) {
            return cached.loaded();
        }
        let loaded = Self::load_uncached(&self.resources, &resource);
        self.cache
            .insert(resource, CachedResource::new(loaded.clone()));
        loaded
    }

    #[cfg(feature = "remote")]
    /// Fetch distinct remote references ahead of layout in bounded batches.
    ///
    /// Eager collection lets blocking requests overlap without moving resource
    /// authority into layout. Every worker enters through [`Self::load_uncached`],
    /// preserving the synchronous path's security and response-size policy.
    pub(crate) fn preload_document_resources<'a>(
        &mut self,
        references: impl IntoIterator<Item = &'a str>,
    ) {
        let base = self.resources.base_path().map(Path::to_path_buf);
        let mut unique = HashSet::new();
        let mut pending = Vec::new();
        for reference in references {
            let Some(resource) = self.resources.resolve(reference, base.as_deref()) else {
                continue;
            };
            if !matches!(resource, ResolvedResource::Remote(_))
                || self.cache.contains_key(&resource)
                || !unique.insert(resource.clone())
            {
                continue;
            }
            pending.push(resource);
        }

        for batch in pending.chunks(MAX_CONCURRENT_REMOTE_FETCHES) {
            if let [resource] = batch {
                let loaded = Self::load_uncached(&self.resources, resource);
                self.cache
                    .insert(resource.clone(), CachedResource::new(loaded));
                continue;
            }
            let completed = std::thread::scope(|scope| {
                let mut workers = Vec::with_capacity(batch.len());
                let mut synchronous_fallbacks = Vec::new();
                for resource in batch.iter().cloned() {
                    let resources = &self.resources;
                    let fallback = resource.clone();
                    match std::thread::Builder::new().spawn_scoped(scope, move || {
                        let loaded = Self::load_uncached(resources, &resource);
                        (resource, CachedResource::new(loaded))
                    }) {
                        Ok(worker) => workers.push(worker),
                        Err(_) => synchronous_fallbacks.push(fallback),
                    }
                }
                let mut completed = workers
                    .into_iter()
                    .filter_map(|worker| worker.join().ok())
                    .collect::<Vec<_>>();
                completed.extend(synchronous_fallbacks.into_iter().map(|resource| {
                    let loaded = Self::load_uncached(&self.resources, &resource);
                    (resource, CachedResource::new(loaded))
                }));
                completed
            });
            self.cache.extend(completed);
        }
    }

    /// Keep synchronous misses and concurrent preloads on one policy boundary.
    fn load_uncached(
        _resources: &DocumentResources,
        resource: &ResolvedResource,
    ) -> Option<LoadedResource> {
        let loaded = match resource {
            ResolvedResource::Inline(uri) => load_data_uri(uri)?,
            ResolvedResource::Fragment(_) => return None,
            ResolvedResource::Local(path) => LoadedResource {
                bytes: std::fs::read(path.as_path()).ok()?,
                media_type: None,
            },
            #[cfg(feature = "remote")]
            ResolvedResource::Remote(url) => LoadedResource {
                bytes: crate::security::network::fetch_authorized(url, &_resources.network)?,
                media_type: None,
            },
            #[cfg(not(feature = "remote"))]
            ResolvedResource::Remote(_) => return None,
        };
        Some(loaded)
    }
}

fn load_data_uri(uri: &str) -> Option<LoadedResource> {
    let rest = uri.get(5..)?;
    let (header, encoded) = rest.split_once(',')?;
    let header_lower = header.to_ascii_lowercase();
    let bytes = if header_lower
        .split(';')
        .any(|part| part.eq_ignore_ascii_case("base64"))
    {
        decode_base64(encoded)?
    } else {
        percent_decode(encoded).into_bytes()
    };
    let media_type = header_lower
        .split(';')
        .next()
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    Some(LoadedResource { bytes, media_type })
}

fn percent_decode(input: &str) -> String {
    let mut output = Vec::with_capacity(input.len());
    let bytes = input.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%'
            && let Some(pair) = bytes.get(index + 1..index + 3)
            && let (Some(high), Some(low)) = (hex_value(pair[0]), hex_value(pair[1]))
        {
            output.push((high << 4) | low);
            index += 3;
            continue;
        }
        output.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&output).into_owned()
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}
