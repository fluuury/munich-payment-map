import React, { useEffect, useRef, useState, useCallback } from 'react';
import maplibregl from 'maplibre-gl';
import { Analytics } from '@vercel/analytics/react';
import osmtogeojson from 'osmtogeojson';
import 'maplibre-gl/dist/maplibre-gl.css';
import { supabase } from './supabaseClient.js';
import './App.css';

function App() {
  const mapContainer = useRef(null);
  const map = useRef(null);
  const masterData = useRef(null);
  const popupRef = useRef(null);
  const retryCount = useRef(0);
  const maxRetries = 3;
  const blacklistSet = useRef(new Set()); // Store blacklisted OSM IDs
  
  const [activeFilter, setActiveFilter] = useState('all');
  const [showWelcome, setShowWelcome] = useState(true);
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  const [toastMessage, setToastMessage] = useState(null);
  const [stats, setStats] = useState({ total: 0, mapped: 0, percent: 0 });
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);

  // 🛡️ HELPER: Majority Rule Calculation (Memoized)
  const calculateStatus = useCallback((votes) => {
    const card = votes.card_votes || 0;
    const girocard = votes.ec_votes || 0; 
    const cash = votes.cash_votes || 0;

    if (card >= girocard && card >= cash && card > 0) {
      return { color: '#34C759', text: `Verified: Accepts All Common Cards (${card} votes)`, type: 'card' };
    } 
    else if (girocard >= cash && girocard > 0) {
      return { color: '#FFCC00', text: `Verified: Girocard Only (${girocard} votes)`, type: 'girocard' };
    } 
    else if (cash > 0) {
      return { color: '#FF3B30', text: `Verified: Cash Only (${cash} votes)`, type: 'cash' };
    }
    
    return { color: '#b0bec5', text: 'Unknown', type: 'unknown' };
  }, []);

  // Fetch Overpass data with retry logic
  const fetchOverpassData = useCallback(async (isRetry = false) => {
    if (isRetry) {
      console.log(`Retry attempt ${retryCount.current + 1} of ${maxRetries}`);
    }
    
    setIsLoading(true);
    setLoadError(null);

    const query = `
      [out:json][timeout:25];
      (
        node["amenity"~"bar|pub|cafe|biergarten|restaurant|fast_food|nightclub|ice_cream"](48.06,11.36,48.25,11.79); 
      );
      out body;
    `;

    try {
      // Fetch Overpass data
      const response = await fetch("https://overpass-api.de/api/interpreter", {
        method: "POST",
        body: query,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      });
      
      if (!response.ok) {
        throw new Error(`Overpass API error: ${response.status} ${response.statusText}`);
      }
      
      const data = await response.json();
      
      if (!data || !data.elements || data.elements.length === 0) {
        throw new Error('No data received from Overpass API');
      }
      
      const geoJson = osmtogeojson(data);

      if (!geoJson || !geoJson.features || geoJson.features.length === 0) {
        throw new Error('Failed to convert OSM data to GeoJSON');
      }

      console.log(`Successfully fetched ${geoJson.features.length} venues from Overpass`);

      // 🚫 FETCH BLACKLIST from Supabase
      const { data: blacklistData, error: blacklistError } = await supabase
        .from('venue_blacklist')
        .select('osm_id');

      if (blacklistError) {
        console.error('Error fetching blacklist:', blacklistError);
        // Continue without blacklist if fetch fails
      } else if (blacklistData && blacklistData.length > 0) {
        blacklistSet.current = new Set(blacklistData.map(item => item.osm_id));
        console.log(`Fetched ${blacklistSet.current.size} blacklisted venues`);
      }

      // Fetch ALL votes from Supabase (with pagination to handle >1000 records)
      let allVotes = [];
      let from = 0;
      const pageSize = 1000;
      let hasMore = true;

      while (hasMore) {
        const { data: voteData, error: voteError } = await supabase
          .from('venue_votes')
          .select('*')
          .range(from, from + pageSize - 1);

        if (voteError) {
          console.error('Error fetching votes:', voteError);
          // Don't throw - continue with empty votes if Supabase fails
          break;
        }

        if (voteData && voteData.length > 0) {
          allVotes = [...allVotes, ...voteData];
          from += pageSize;
          
          if (voteData.length < pageSize) {
            hasMore = false;
          }
        } else {
          hasMore = false;
        }
      }

      console.log(`Fetched ${allVotes.length} votes from Supabase`);
      
      // Create votes lookup map for O(1) access
      const votesMap = new Map();
      allVotes.forEach(vote => votesMap.set(vote.osm_id, vote));
      
      // 🚫 FILTER OUT BLACKLISTED VENUES
      geoJson.features = geoJson.features.filter(feature => {
        const isBlacklisted = blacklistSet.current.has(feature.id);
        if (isBlacklisted) {
          console.log(`Filtering out blacklisted venue: ${feature.id}`);
        }
        return !isBlacklisted;
      });

      console.log(`${geoJson.features.length} venues after blacklist filtering`);

      // Process features
      geoJson.features.forEach((feature) => {
        const p = feature.properties;
        const existingVote = votesMap.get(feature.id);
        const votes = existingVote || { cash_votes: 0, ec_votes: 0, card_votes: 0 };
        
        let status = calculateStatus(votes);

        // Fallback to OSM tags if no votes exist
        if (status.type === 'unknown') {
          if (p['payment:cards'] === 'no') {
            status = { color: '#FF3B30', text: 'Cash Only (OSM)', type: 'cash' };
          } 
          else if (p['payment:visa'] === 'yes' || p['payment:mastercard'] === 'yes' || p['payment:cards'] === 'yes') {
            status = { color: '#34C759', text: 'Accepts All Common Cards (OSM)', type: 'card' };
          } 
          else if (p['payment:girocard'] === 'yes') {
            status = { color: '#FFCC00', text: 'Girocard Only (OSM)', type: 'girocard' };
          }
        }

        feature.properties.marker_color = status.color;
        feature.properties.payment_status = status.text;
        feature.properties.filter_type = status.type;
        feature.properties.votes = votes;
      });

      // Calculate stats
      const totalVenues = geoJson.features.length;
      const mappedVenues = geoJson.features.filter(f => f.properties.filter_type !== 'unknown').length;
      const percentage = totalVenues > 0 ? Math.round((mappedVenues / totalVenues) * 100) : 0;

      setStats({ total: totalVenues, mapped: mappedVenues, percent: percentage });
      masterData.current = geoJson;

      // Update map source
      if (map.current && map.current.getSource('places')) {
        map.current.getSource('places').setData(geoJson);
      } else if (map.current) {
        map.current.addSource('places', {
          type: 'geojson',
          data: geoJson,
          promoteId: 'id'
        });

        map.current.addLayer({
          id: 'places-dots',
          type: 'circle',
          source: 'places',
          paint: {
            'circle-radius': 6,
            'circle-stroke-width': 1,
            'circle-stroke-color': '#fff',
            'circle-color': ['get', 'marker_color']
          }
        });

        setupPopupInteraction();
      }

      setIsLoading(false);
      retryCount.current = 0; // Reset retry count on success
      
    } catch (error) {
      console.error("Error fetching data:", error);
      
      // Retry logic
      if (retryCount.current < maxRetries) {
        retryCount.current++;
        setLoadError(`Loading failed. Retrying... (${retryCount.current}/${maxRetries})`);
        
        // Exponential backoff: 1s, 2s, 4s
        const delay = Math.pow(2, retryCount.current - 1) * 1000;
        setTimeout(() => {
          fetchOverpassData(true);
        }, delay);
      } else {
        setIsLoading(false);
        setLoadError('Failed to load venue data. Please refresh the page.');
        console.error('Max retries reached. Please refresh the page.');
      }
    }
  }, [calculateStatus]);

  // Setup popup interaction (memoized)
  const setupPopupInteraction = useCallback(() => {
    if (!map.current) return;

    const handleClick = (e) => {
      const clickedFeature = e.features[0]; 
      const coordinates = clickedFeature.geometry.coordinates.slice();
      const name = clickedFeature.properties.name || "Unknown Place";
      const currentStatus = clickedFeature.properties.payment_status;

      // Parse votes safely
      let votes = clickedFeature.properties.votes;
      if (typeof votes === 'string') {
        try { 
          votes = JSON.parse(votes); 
        } catch(err) { 
          votes = {cash_votes: 0, ec_votes: 0, card_votes: 0}; 
        }
      }

      const votedVenues = JSON.parse(localStorage.getItem('votedVenues') || '{}');
      const hasVoted = votedVenues[clickedFeature.id];

      const reportedVenues = JSON.parse(localStorage.getItem('reportedVenues') || '{}');
      const hasReported = reportedVenues[clickedFeature.id];

      const popupNode = document.createElement('div');
      
      const buttonsHtml = hasVoted 
        ? `<p style="text-align:center; color:#34C759; font-weight:bold; margin-top:10px;">✅ You voted!</p>`
        : `
          <div style="display: flex; gap: 5px; margin-top: 10px;">
            <button id="vote-cash" style="background:#FF3B30; color:white; border:none; padding:8px; border-radius:4px; cursor:pointer; font-weight:bold;">Cash</button>
            <button id="vote-ec" style="background:#FFCC00; color:black; border:none; padding:8px; border-radius:4px; cursor:pointer; font-weight:bold;">Girocard</button>
            <button id="vote-card" style="background:#34C759; color:white; border:none; padding:8px; border-radius:4px; cursor:pointer; font-weight:bold;">All Cards</button>
          </div>`;

      const reportButtonHtml = hasReported
        ? `<p style="text-align:center; color:#FF9500; font-size:11px; margin-top:8px;">⚠️ Already reported</p>`
        : `<button id="report-closed" style="background:#FF9500; color:white; border:none; padding:6px 10px; border-radius:4px; cursor:pointer; font-size:11px; margin-top:8px; width:100%;">🚩 Report as closed/moved</button>`;

      popupNode.innerHTML = `
        <div style="font-family: sans-serif; padding: 5px; min-width: 160px;">
          <h3 style="margin:0 0 10px; color: #000;">${name}</h3>
          <p style="margin:0 0 5px; font-size: 13px; color: #666;">Status: <strong>${currentStatus}</strong></p>
          <p style="margin:0 0 10px; font-size: 11px; color: #999;">
             Cash: <strong>${votes.cash_votes}</strong> | Giro: <strong>${votes.ec_votes}</strong> | Card: <strong>${votes.card_votes}</strong>
          </p>
          ${buttonsHtml}
          ${reportButtonHtml}
        </div>
      `;

      // Close existing popup if any
      if (popupRef.current) {
        popupRef.current.remove();
      }

      const popup = new maplibregl.Popup({ closeButton: true })
        .setLngLat(coordinates)
        .setDOMContent(popupNode)
        .addTo(map.current);

      popupRef.current = popup;

      // Handle voting
      const handleVote = async (voteType) => {
        try {
          const match = masterData.current.features.find(f => f.id === clickedFeature.id);
          if (!match) {
            console.error('Feature not found in masterData');
            return;
          }

          const wasUnknown = match.properties.filter_type === 'unknown';

          const col = `${voteType}_votes`.replace('girocard', 'ec'); 
          const newCount = match.properties.votes[col] + 1;

          // Update database
          const { data: upsertData, error: dbError } = await supabase
            .from('venue_votes')
            .upsert({
              osm_id: clickedFeature.id,
              name: match.properties.name || 'Unknown',
              cash_votes: voteType === 'cash' ? newCount : match.properties.votes.cash_votes,
              ec_votes: voteType === 'girocard' ? newCount : match.properties.votes.ec_votes,
              card_votes: voteType === 'card' ? newCount : match.properties.votes.card_votes
            }, { onConflict: 'osm_id' });

          if (dbError) {
            console.error("Database Save Error:", dbError);
            alert('Failed to save vote. Please try again.');
            return; 
          }

          // Update local data
          match.properties.votes[col] = newCount; 
          const newStatus = calculateStatus(match.properties.votes);
          match.properties.marker_color = newStatus.color;
          match.properties.payment_status = newStatus.text;
          match.properties.filter_type = newStatus.type;

          // Update stats if venue went from unknown to known
          if (wasUnknown && newStatus.type !== 'unknown') {
            setStats(prev => {
              const newMapped = prev.mapped + 1;
              return { 
                total: prev.total,
                mapped: newMapped, 
                percent: Math.round((newMapped / prev.total) * 100) 
              };
            });
          }

          // Save vote to localStorage
          const updatedVotedVenues = JSON.parse(localStorage.getItem('votedVenues') || '{}');
          updatedVotedVenues[clickedFeature.id] = true;
          localStorage.setItem('votedVenues', JSON.stringify(updatedVotedVenues));

          // Update map
          map.current.getSource('places').setData(masterData.current);
          
          // Show random toast message
          const messages = [
            "Sauber! Thanks for helping Munich. 🥨",
            "Vote saved! One step closer to the 21st century. 🚀",
            "Boom! Another one mapped. 👊",
            "Doing the lord's work. Thanks! 🙌",
            "Got it! Death to the ATM run. 🏃💨",
            "You are a legend. Vote saved. ✅",
            "Not all heroes wear capes. Some map payment methods. 🙌"
          ];
          setToastMessage(messages[Math.floor(Math.random() * messages.length)]);
          
          popup.remove();
          setTimeout(() => setToastMessage(null), 3000);
        } catch (error) {
          console.error('Error in handleVote:', error);
          alert('An error occurred while saving your vote.');
        }
      };

      // 🚩 Handle Report Closed/Moved
      const handleReport = async () => {
        try {
          const { data: insertData, error: reportError } = await supabase
            .from('venue_suggestions')
            .insert({
              osm_id: clickedFeature.id, // Keep the 'node/12345' format
              venue_name: name,
              suggestion_type: 'report_closed',
              status: 'pending'
            });

          if (reportError) {
            console.error("Report submission error:", reportError);
            alert('Failed to submit report. Please try again.');
            return;
          }

          // Save to localStorage to prevent duplicate reports
          const updatedReportedVenues = JSON.parse(localStorage.getItem('reportedVenues') || '{}');
          updatedReportedVenues[clickedFeature.id] = true;
          localStorage.setItem('reportedVenues', JSON.stringify(updatedReportedVenues));

          // Show toast notification
          const reportMessages = [
            "Report submitted! Thanks for keeping the map accurate. 🙏",
            "Got it! We'll check this venue. Thanks! 👍",
            "Report received! Helping keep Munich's map clean. 🧹",
            "Thanks for the heads up! Report submitted. ✅"
          ];
          setToastMessage(reportMessages[Math.floor(Math.random() * reportMessages.length)]);

          popup.remove();
          setTimeout(() => setToastMessage(null), 3000);
        } catch (error) {
          console.error('Error in handleReport:', error);
          alert('An error occurred while submitting your report.');
        }
      };

      // Attach event listeners
      if (!hasVoted) {
        const cashBtn = popupNode.querySelector('#vote-cash');
        const ecBtn = popupNode.querySelector('#vote-ec');
        const cardBtn = popupNode.querySelector('#vote-card');
        
        if (cashBtn) cashBtn.onclick = () => handleVote('cash');
        if (ecBtn) ecBtn.onclick = () => handleVote('girocard');
        if (cardBtn) cardBtn.onclick = () => handleVote('card');
      }

      if (!hasReported) {
        const reportBtn = popupNode.querySelector('#report-closed');
        if (reportBtn) reportBtn.onclick = handleReport;
      }
    };

    // Remove old listeners before adding new ones
    map.current.off('click', 'places-dots', handleClick);
    map.current.on('click', 'places-dots', handleClick);

    map.current.on('mouseenter', 'places-dots', () => {
      map.current.getCanvas().style.cursor = 'pointer';
    });
    
    map.current.on('mouseleave', 'places-dots', () => {
      map.current.getCanvas().style.cursor = '';
    });
  }, [calculateStatus, setStats, setToastMessage]);

  // Apply filter (memoized)
  const applyFilter = useCallback((category) => {
    setActiveFilter(category);
    if (!masterData.current) return;

    const filteredFeatures = category === 'all' 
      ? masterData.current.features 
      : masterData.current.features.filter(f => 
          f.properties.filter_type === category.replace('ec', 'girocard')
        );

    if (map.current && map.current.getSource('places')) {
      map.current.getSource('places').setData({ 
        type: 'FeatureCollection', 
        features: filteredFeatures 
      });
    }
  }, []);

  // Initialize map
  useEffect(() => {
    if (map.current) return; // Prevent re-initialization

    map.current = new maplibregl.Map({
      container: mapContainer.current,
      style: {
        version: 8,
        sources: {
          'carto-light': {
            type: 'raster',
            tiles: ['https://basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png'],
            tileSize: 256,
            attribution: '&copy; OpenStreetMap &copy; CARTO',
          },
        },
        layers: [
          {
            id: 'carto-light-layer',
            type: 'raster',
            source: 'carto-light',
            minzoom: 0,
            maxzoom: 22,
          },
        ],
      },
      center: [11.5820, 48.1351], 
      zoom: 12, 
    });

    map.current.addControl(new maplibregl.NavigationControl(), 'top-right');
    map.current.addControl(
      new maplibregl.GeolocateControl({
        positionOptions: { enableHighAccuracy: true },
        trackUserLocation: true, 
        showUserHeading: true    
      }),
      'bottom-right' 
    );

    map.current.on('load', () => {
      console.log('Map loaded successfully');
      fetchOverpassData();
    });

    // Cleanup function
    return () => {
      if (map.current) {
        map.current.remove();
        map.current = null;
      }
    };
  }, [fetchOverpassData]);

  const WelcomePopup = () => {
    if (!showWelcome) return null;
    
    return (
      <div className="welcome-overlay">
        <div className="welcome-box">
          <h2>👋 Welcome to MUC-PAY!</h2>
          <p>This map is a community project to help you avoid the "Cash Only" frustration in Munich.</p>
          <p>The status of each dot is determined by your votes:</p>
          <ul style={{ paddingLeft: '20px', listStyleType: 'none', margin: '15px 0' }}>
            <li style={{ marginBottom: '8px' }}>
              <span style={{ color: '#34C759', fontWeight: 'bold' }}>🟢 All Common Cards:</span> Accepts most modern cards (Visa, Mastercard, Apple Pay, etc.).
            </li>
            <li style={{ marginBottom: '8px' }}>
              <span style={{ color: '#FFCC00', fontWeight: 'bold' }}>🟡 Girocard:</span> Accepts German bank cards (Girocard/EC) only.
            </li>
            <li style={{ marginBottom: '8px' }}>
              <span style={{ color: '#FF3B30', fontWeight: 'bold' }}>🔴 Cash:</span> Primarily cash, or they are known to reject cards.
            </li>
            <li style={{ marginBottom: '8px' }}>
              <span style={{ color: '#b0bec5', fontWeight: 'bold' }}>⚪ Unknown:</span> No one has voted here yet.
            </li>
          </ul>
          <p>Click any dot on the map, cast your single vote, and let's make Munich a better place for card payments!</p>
          <button 
            onClick={() => { 
              setShowWelcome(false); 
              setTimeout(() => map.current?.resize(), 300); 
            }} 
            className="close-button"
          >
            Start Mapping!
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className="map-wrap">
      <div ref={mapContainer} className="map" />
      
      {/* 📊 TOP PROGRESS BAR */}
      <div className="top-progress-bar">
        <div className="progress-text">
          <span>Munich Progress: <strong>{stats.percent}%</strong></span>
          <span className="details">{stats.mapped}/{stats.total}</span>
        </div>
        <div className="progress-track">
          <div className="progress-fill" style={{ width: `${stats.percent}%` }}></div>
        </div>
      </div>

      {/* 🔽 BOTTOM FILTER SECTION */}
      <div className="bottom-filter-section">
        {isFilterOpen && (
          <div className="filter-options-row">
            <button 
              className={activeFilter === 'all' ? 'active' : ''} 
              onClick={() => { applyFilter('all'); setIsFilterOpen(false); }}
            >
              All
            </button>
            <button 
              className={activeFilter === 'card' ? 'active' : ''} 
              onClick={() => { applyFilter('card'); setIsFilterOpen(false); }}
            >
              Card 🟢
            </button>
            <button 
              className={activeFilter === 'ec' ? 'active' : ''} 
              onClick={() => { applyFilter('ec'); setIsFilterOpen(false); }}
            >
              Giro 🟡
            </button>
            <button 
              className={activeFilter === 'cash' ? 'active' : ''} 
              onClick={() => { applyFilter('cash'); setIsFilterOpen(false); }}
            >
              Cash 🔴
            </button>
          </div>
        )}
        <button 
          className="filter-toggle-main" 
          onClick={() => setIsFilterOpen(!isFilterOpen)}
        >
          {isFilterOpen ? 'Close ✖' : 'Filters 🌪️'}
        </button>
      </div>

      <img src="/android-chrome-512x512.png" className="watermark-logo" alt="Logo" />
      <Analytics /> 
      <WelcomePopup />
      
      {/* Loading indicator */}
      {isLoading && (
        <div className="toast-notification" style={{ top: '50%', transform: 'translate(-50%, -50%)' }}>
          {loadError || 'Loading venues... 🗺️'}
        </div>
      )}
      
      {/* Error message with retry button */}
      {!isLoading && loadError && (
        <div className="toast-notification" style={{ 
          top: '50%', 
          transform: 'translate(-50%, -50%)',
          backgroundColor: '#FF3B30',
          cursor: 'pointer',
          display: 'flex',
          flexDirection: 'column',
          gap: '10px',
          padding: '16px 24px'
        }}
        onClick={() => {
          retryCount.current = 0;
          fetchOverpassData();
        }}>
          <div>{loadError}</div>
          <div style={{ fontSize: '12px', opacity: 0.9 }}>Tap to retry</div>
        </div>
      )}
      
      {toastMessage && <div className="toast-notification">{toastMessage}</div>}
    </div>
  );
}

export default App;