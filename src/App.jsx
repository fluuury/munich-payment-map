import React, { useEffect, useRef, useState } from 'react';
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
  
  const [activeFilter, setActiveFilter] = useState('all');
  const [showWelcome, setShowWelcome] = useState(true);
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  const [toastMessage, setToastMessage] = useState(null);
  const [stats, setStats] = useState({ total: 0, mapped: 0, percent: 0 });

  // 🛡️ HELPER: Majority Rule Calculation
  const calculateStatus = (votes) => {
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
  };

  useEffect(() => {
    if (map.current) return;

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
      fetchOverpassData();
    });
  }, []);

  const fetchOverpassData = async () => {
    const query = `
      [out:json][timeout:25];
      (
        node["amenity"~"bar|pub|cafe|biergarten|restaurant|fast_food|nightclub|ice_cream"](48.06,11.36,48.25,11.79); 
      );
      out body;
    `;

    try {
      const response = await fetch("https://overpass-api.de/api/interpreter", {
        method: "POST",
        body: query
      });
      const data = await response.json();
      const geoJson = osmtogeojson(data);

      const { data: voteData, error: voteError } = await supabase
        .from('venue_votes')
        .select('*');

      if (voteError) console.error('Error fetching votes:', voteError);
      
      const votesMap = new Map();
      if (voteData) {
        voteData.forEach(vote => votesMap.set(vote.osm_id, vote));
      }
      
      geoJson.features.forEach((feature) => {
        const p = feature.properties;
        const existingVote = votesMap.get(feature.id);
        const votes = existingVote || { cash_votes: 0, ec_votes: 0, card_votes: 0 };
        
        let status = calculateStatus(votes);

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

      const totalVenues = geoJson.features.length;
      const mappedVenues = geoJson.features.filter(f => f.properties.filter_type !== 'unknown').length;
      const percentage = totalVenues > 0 ? Math.round((mappedVenues / totalVenues) * 100) : 0;

      setStats({ total: totalVenues, mapped: mappedVenues, percent: percentage });
      masterData.current = geoJson;

      if (map.current.getSource('places')) {
        map.current.removeLayer('places-dots');
        map.current.removeSource('places');
      }

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
    } catch (error) {
      console.error("Fatal Error fetching data:", error);
    }
  };

  const applyFilter = (category) => {
    setActiveFilter(category);
    if (!masterData.current) return;

    let filteredFeatures = category === 'all' 
      ? masterData.current.features 
      : masterData.current.features.filter(f => f.properties.filter_type === category.replace('ec', 'girocard'));

    map.current.getSource('places').setData({ type: 'FeatureCollection', features: filteredFeatures });
  };

  const setupPopupInteraction = () => {
    map.current.off('click', 'places-dots');
    map.current.on('click', 'places-dots', (e) => {
        const clickedFeature = e.features[0]; 
        const coordinates = clickedFeature.geometry.coordinates.slice();
        const name = clickedFeature.properties.name || "Unknown Place";
        const currentStatus = clickedFeature.properties.payment_status;

        let votes = clickedFeature.properties.votes;
        if (typeof votes === 'string') {
             try { votes = JSON.parse(votes); } catch(err) { votes = {cash_votes:0, ec_votes:0, card_votes:0}; }
        }

        const votedVenues = JSON.parse(localStorage.getItem('votedVenues') || '{}');
        const hasVoted = votedVenues[clickedFeature.id];

        const popupNode = document.createElement('div');
        
        let buttonsHtml = hasVoted 
          ? `<p style="text-align:center; color:#34C759; font-weight:bold; margin-top:10px;">✅ You voted!</p>`
          : `
            <div style="display: flex; gap: 5px; margin-top: 10px;">
              <button id="vote-cash" style="background:#FF3B30; color:white; border:none; padding:8px; border-radius:4px; cursor:pointer; font-weight:bold;">Cash</button>
              <button id="vote-ec" style="background:#FFCC00; color:black; border:none; padding:8px; border-radius:4px; cursor:pointer; font-weight:bold;">Girocard</button>
              <button id="vote-card" style="background:#34C759; color:white; border:none; padding:8px; border-radius:4px; cursor:pointer; font-weight:bold;">All Cards</button>
            </div>`;

        popupNode.innerHTML = `
          <div style="font-family: sans-serif; padding: 5px; min-width: 160px;">
            <h3 style="margin:0 0 10px; color: #000;">${name}</h3>
            <p style="margin:0 0 5px; font-size: 13px; color: #666;">Status: <strong>${currentStatus}</strong></p>
            <p style="margin:0 0 10px; font-size: 11px; color: #999;">
               Cash: <strong>${votes.cash_votes}</strong> | Giro: <strong>${votes.ec_votes}</strong> | Card: <strong>${votes.card_votes}</strong>
            </p>
            ${buttonsHtml}
          </div>
        `;

        const popup = new maplibregl.Popup()
          .setLngLat(coordinates)
          .setDOMContent(popupNode)
          .addTo(map.current);

        const handleVote = async (voteType) => {
            const match = masterData.current.features.find(f => f.id === clickedFeature.id);
            if (!match) return;

            const wasUnknown = match.properties.filter_type === 'unknown';

            let col = `${voteType}_votes`.replace('girocard', 'ec'); 
            let newCount = match.properties.votes[col] + 1;

            const { error: dbError } = await supabase
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
                return; 
            }

            match.properties.votes[col] = newCount; 
            const newStatus = calculateStatus(match.properties.votes);
            match.properties.marker_color = newStatus.color;
            match.properties.payment_status = newStatus.text;
            match.properties.filter_type = newStatus.type;

            if (wasUnknown && newStatus.type !== 'unknown') {
                setStats(prev => {
                    const newMapped = prev.mapped + 1;
                    return { ...prev, mapped: newMapped, percent: Math.round((newMapped / prev.total) * 100) };
                });
            }

            votedVenues[clickedFeature.id] = true;
            localStorage.setItem('votedVenues', JSON.stringify(votedVenues));

            map.current.getSource('places').setData(masterData.current);
            
            // Random Toast Messages Restored
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
        };

        if (!hasVoted) {
            popupNode.querySelector('#vote-cash').onclick = () => handleVote('cash');
            popupNode.querySelector('#vote-ec').onclick = () => handleVote('girocard');
            popupNode.querySelector('#vote-card').onclick = () => handleVote('card');
        }
      });

      map.current.on('mouseenter', 'places-dots', () => map.current.getCanvas().style.cursor = 'pointer');
      map.current.on('mouseleave', 'places-dots', () => map.current.getCanvas().style.cursor = '');
  };

  const WelcomePopup = () => {
    if (!showWelcome) return null;
    return (
      <div className="welcome-overlay">
        <div className="welcome-box">
          <h2>👋 Welcome to MUC-PAY!</h2>
          <p>This map is a community project to help you avoid the "Cash Only" frustration in Munich. </p>
          <p>The status of each dot is determined by your votes:</p>
          <ul style={{ paddingLeft: '20px', listStyleType: 'none', margin: '15px 0' }}>
            <li style={{ marginBottom: '8px' }}><span style={{ color: '#34C759', fontWeight: 'bold' }}>🟢 All Common Cards:</span> Accepts most modern cards (Visa, Mastercard, Apple Pay, etc.).</li>
            <li style={{ marginBottom: '8px' }}><span style={{ color: '#FFCC00', fontWeight: 'bold' }}>🟡 Girocard:</span> Accepts German bank cards (Girocard/EC) only.</li>
            <li style={{ marginBottom: '8px' }}><span style={{ color: '#FF3B30', fontWeight: 'bold' }}>🔴 Cash:</span> Primarily cash, or they are known to reject cards.</li>
            <li style={{ marginBottom: '8px' }}><span style={{ color: '#b0bec5', fontWeight: 'bold' }}>⚪ Unknown:</span> No one has voted here yet.</li>
          </ul>
          <p>Click any dot on the map, cast your single vote, and let's make Munich a better place for card payments!</p>
          <button onClick={() => { setShowWelcome(false); setTimeout(() => map.current.resize(), 300); }} className="close-button">Start Mapping!</button>
        </div>
      </div>
    );
  };

  return (
    <div className="map-wrap">
      <div ref={mapContainer} className="map" />
      
      {/* 📊 BOTTOM DASHBOARD */}
      <div className="bottom-dashboard">
        <div className="gamification-bar">
          <div className="progress-text">
            <span>Munich Progress: <strong>{stats.percent}%</strong></span>
            <span className="details">{stats.mapped}/{stats.total}</span>
          </div>
          <div className="progress-track"><div className="progress-fill" style={{ width: `${stats.percent}%` }}></div></div>
        </div>

        <div className="filter-section">
          {isFilterOpen && (
            <div className="filter-options-row">
              <button className={activeFilter === 'all' ? 'active' : ''} onClick={() => { applyFilter('all'); setIsFilterOpen(false); }}>All</button>
              <button className={activeFilter === 'card' ? 'active' : ''} onClick={() => { applyFilter('card'); setIsFilterOpen(false); }}>Card 🟢</button>
              <button className={activeFilter === 'ec' ? 'active' : ''} onClick={() => { applyFilter('ec'); setIsFilterOpen(false); }}>Giro 🟡</button>
              <button className={activeFilter === 'cash' ? 'active' : ''} onClick={() => { applyFilter('cash'); setIsFilterOpen(false); }}>Cash 🔴</button>
            </div>
          )}
          <button className="filter-toggle-main" onClick={() => setIsFilterOpen(!isFilterOpen)}>
            {isFilterOpen ? 'Close ✖' : 'Filters 🌪️'}
          </button>
        </div>
      </div>

      <img src="/android-chrome-512x512.png" className="watermark-logo" alt="Logo" />
      <Analytics /> 
      <WelcomePopup />
      {toastMessage && <div className="toast-notification">{toastMessage}</div>}
    </div>
  );
}

export default App;