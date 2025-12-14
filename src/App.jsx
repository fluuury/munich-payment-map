import React, { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import osmtogeojson from 'osmtogeojson';
import 'maplibre-gl/dist/maplibre-gl.css';
import { supabase } from './supabaseClient.js';
import './App.css';

function App() {
  const mapContainer = useRef(null);
  const map = useRef(null);
  const masterData = useRef(null);
  
  // State for filtering and welcome popup
  const [activeFilter, setActiveFilter] = useState('all');
  const [showWelcome, setShowWelcome] = useState(true);

  // 🛡️ HELPER: Majority Rule Calculation
  const calculateStatus = (votes) => {
    const card = votes.card_votes || 0;
    const girocard = votes.ec_votes || 0; 
    const cash = votes.cash_votes || 0;

    if (card >= girocard && card >= cash && card > 0) {
      return { color: '#00e676', text: `Verified: Accepts Cards (${card} votes)`, type: 'card' };
    } 
    else if (girocard >= cash && girocard > 0) {
      return { color: '#ffea00', text: `Verified: Girocard Only (${girocard} votes)`, type: 'girocard' };
    } 
    else if (cash > 0) {
      return { color: '#ff5252', text: `Verified: Cash Only (${cash} votes)`, type: 'cash' };
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

      if (voteError) {
        console.error('Error fetching votes:', voteError);
      }
      
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
               status = { color: '#ff5252', text: 'Cash Only (OSM)', type: 'cash' };
            } 
            else if (p['payment:visa'] === 'yes' || p['payment:mastercard'] === 'yes' || p['payment:cards'] === 'yes') {
               status = { color: '#00e676', text: 'Accepts Cards (OSM)', type: 'card' };
            } 
            else if (p['payment:girocard'] === 'yes') {
               status = { color: '#ffea00', text: 'Girocard Only (OSM)', type: 'girocard' };
            }
        }

        feature.properties.marker_color = status.color;
        feature.properties.payment_status = status.text;
        feature.properties.filter_type = status.type;
        feature.properties.votes = votes;
      });

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

    let filteredFeatures;

    if (category === 'all') {
      filteredFeatures = masterData.current.features;
    } else {
      filteredFeatures = masterData.current.features.filter(f => 
        f.properties.filter_type === category.replace('ec', 'girocard')
      );
    }

    const filteredGeoJson = {
      type: 'FeatureCollection',
      features: filteredFeatures
    };
    
    map.current.getSource('places').setData(filteredGeoJson);
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
             try { votes = JSON.parse(votes); } catch(e) { votes = {cash_votes:0, ec_votes:0, card_votes:0}; }
        }

        const votedVenues = JSON.parse(localStorage.getItem('votedVenues') || '{}');
        const hasVoted = votedVenues[clickedFeature.id];

        const popupNode = document.createElement('div');
        
        let buttonsHtml = '';
        if (hasVoted) {
            buttonsHtml = `<p style="text-align:center; color:#00e676; font-weight:bold; margin-top:10px;">✅ You voted!</p>`;
        } else {
            buttonsHtml = `
            <div style="display: flex; gap: 5px; margin-top: 10px;">
              <button id="vote-cash" style="background:#ff5252; color:white; border:none; padding:8px; border-radius:4px; cursor:pointer; font-weight:bold;">Cash</button>
              <button id="vote-ec" style="background:#ffea00; color:black; border:none; padding:8px; border-radius:4px; cursor:pointer; font-weight:bold;">Girocard</button>
              <button id="vote-card" style="background:#00e676; color:white; border:none; padding:8px; border-radius:4px; cursor:pointer; font-weight:bold;">Card</button>
            </div>`;
        }

        popupNode.innerHTML = `
          <div style="font-family: sans-serif; padding: 5px; min-width: 160px;">
            <h3 style="margin:0 0 10px; color: #000;">${name}</h3>
            <p style="margin:0 0 5px; font-size: 13px; color: #666;">
              Status: <strong>${currentStatus}</strong>
            </p>
            <p style="margin:0 0 10px; font-size: 11px; color: #999;">
               Cash: <strong>${votes.cash_votes}</strong> | Girocard: <strong>${votes.ec_votes}</strong> | Card: <strong>${votes.card_votes}</strong>
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

            let columnToIncrement = `${voteType}_votes`.replace('girocard', 'ec'); 
            let newVoteCount = match.properties.votes[columnToIncrement] + 1;

            const { error: dbError } = await supabase
                .from('venue_votes')
                .upsert({
                    osm_id: clickedFeature.id,
                    name: match.properties.name || 'Unknown',
                    cash_votes: voteType === 'cash' ? newVoteCount : match.properties.votes.cash_votes,
                    ec_votes: voteType === 'girocard' ? newVoteCount : match.properties.votes.ec_votes,
                    card_votes: voteType === 'card' ? newVoteCount : match.properties.votes.card_votes
                }, 
                { onConflict: 'osm_id' });

            if (dbError) {
                console.error("Database Save Error:", dbError);
                return; 
            }

            match.properties.votes[columnToIncrement] = newVoteCount; 
            
            const newStatus = calculateStatus(match.properties.votes);
            match.properties.marker_color = newStatus.color;
            match.properties.payment_status = newStatus.text;
            match.properties.filter_type = newStatus.type;

            votedVenues[clickedFeature.id] = true;
            localStorage.setItem('votedVenues', JSON.stringify(votedVenues));

            map.current.getSource('places').setData(masterData.current);
            popup.remove();
            alert("Thanks for voting!");
        };

        if (!hasVoted) {
            popupNode.querySelector('#vote-cash').addEventListener('click', () => handleVote('cash'));
            popupNode.querySelector('#vote-ec').addEventListener('click', () => handleVote('girocard'));
            popupNode.querySelector('#vote-card').addEventListener('click', () => handleVote('card'));
        }
      });

      map.current.on('mouseenter', 'places-dots', () => {
        map.current.getCanvas().style.cursor = 'pointer';
      });
      map.current.on('mouseleave', 'places-dots', () => {
        map.current.getCanvas().style.cursor = '';
      });
  };

  const WelcomePopup = () => {
    if (!showWelcome) return null;

    return (
      <div className="welcome-overlay">
        <div className="welcome-box">
          <h2>👋 Welcome to the Payment Map!</h2>
          <p>This map is a community project to help you avoid the "Cash Only" frustration in Munich. </p>
          <p>The status of each dot is determined by your votes:</p>
          
          <ul style={{ paddingLeft: '20px', listStyleType: 'none' }}>
            <li><span style={{ color: '#00e676', fontWeight: 'bold' }}>🟢 Card:</span> Accepts modern cards (Visa, Mastercard, Apple Pay, etc.).</li>
            <li><span style={{ color: '#ffea00', fontWeight: 'bold' }}>🟡 Girocard:</span> Accepts German bank cards (Girocard/EC) only.</li>
            <li><span style={{ color: '#ff5252', fontWeight: 'bold' }}>🔴 Cash:</span> Primarily cash, or they are known to reject cards.</li>
            <li><span style={{ color: '#b0bec5', fontWeight: 'bold' }}>⚪ Unknown:</span> No one has voted here yet.</li>
          </ul>

          <p>Click any dot on the map, cast your single vote, and let's make Munich a better place for card payments!</p>

          <button 
            onClick={() => {
                setShowWelcome(false);
                // 🛠️ Safety Check: Resize map when popup closes
                setTimeout(() => { if (map.current) map.current.resize(); }, 300);
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
      
      <div className="filter-bar">
        <button 
          className={activeFilter === 'all' ? 'active' : ''} 
          onClick={() => applyFilter('all')}>
          All
        </button>
        <button 
          className={activeFilter === 'card' ? 'active' : ''} 
          onClick={() => applyFilter('card')}>
          Card 🟢
        </button>
        <button 
          className={activeFilter === 'ec' ? 'active' : ''} 
          onClick={() => applyFilter('ec')}>
          Girocard 🟡
        </button>
        <button 
          className={activeFilter === 'cash' ? 'active' : ''} 
          onClick={() => applyFilter('cash')}>
          Cash 🔴
        </button>
      </div>

      {/* Analytics Removed to fix crash */}
      
      <WelcomePopup />
    </div>
  );
}

export default App;
