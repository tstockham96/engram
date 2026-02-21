#!/usr/bin/env python3
"""
Generate 5 non-overlapping Enron email datasets from HuggingFace Yale-LILY/aeslc
Each dataset contains 1000 substantive emails (>100 chars, <3000 chars)
"""

import json
import os
from datasets import load_dataset
from typing import List, Dict, Any
import random

def main():
    print("Loading Yale-LILY/aeslc dataset from HuggingFace...")
    
    # Load the full dataset
    try:
        dataset = load_dataset("Yale-LILY/aeslc", split="train")
        print(f"Loaded {len(dataset)} total emails")
    except Exception as e:
        print(f"Error loading dataset: {e}")
        return
    
    # Filter for substantive emails (>100 chars, <3000 chars)
    print("Filtering for substantive emails...")
    filtered_emails = []
    
    for idx, sample in enumerate(dataset):
        body = sample.get('body', '') or sample.get('email_body', '') or str(sample.get('text', ''))
        subject = sample.get('subject', '') or sample.get('subject_line', '') or 'No Subject'
        
        if 100 <= len(body) <= 3000:
            filtered_emails.append({
                'body': body,
                'subject': subject,
                'index': idx
            })
    
    print(f"Found {len(filtered_emails)} substantive emails")
    
    if len(filtered_emails) < 5000:
        print(f"Warning: Only found {len(filtered_emails)} emails, need at least 5000")
        print("Will use all available emails and split as evenly as possible")
    
    # Shuffle to ensure random distribution
    random.seed(42)  # For reproducibility
    random.shuffle(filtered_emails)
    
    # Split into 5 groups of 1000 each
    datasets = []
    emails_per_set = min(1000, len(filtered_emails) // 5)
    
    for i in range(5):
        start_idx = i * emails_per_set
        end_idx = start_idx + emails_per_set
        
        # For the last dataset, take any remaining emails
        if i == 4:
            end_idx = len(filtered_emails)
            
        dataset_emails = filtered_emails[start_idx:end_idx]
        datasets.append(dataset_emails)
        
        print(f"Dataset {i+1}: {len(dataset_emails)} emails")
    
    # Ensure eval-scale-data directory exists
    output_dir = "eval-scale-data"
    os.makedirs(output_dir, exist_ok=True)
    
    # Save each dataset
    for i, dataset_emails in enumerate(datasets):
        filename = f"{output_dir}/enron-emails-{i+1}.json"
        
        with open(filename, 'w', encoding='utf-8') as f:
            json.dump(dataset_emails, f, indent=2, ensure_ascii=False)
        
        print(f"Saved {len(dataset_emails)} emails to {filename}")
    
    # Verify no overlap
    print("\nVerifying no overlap between datasets...")
    all_indices = set()
    for i, dataset_emails in enumerate(datasets):
        indices = {email['index'] for email in dataset_emails}
        overlap = all_indices.intersection(indices)
        if overlap:
            print(f"ERROR: Dataset {i+1} has {len(overlap)} overlapping emails!")
        else:
            print(f"Dataset {i+1}: No overlap ✓")
        all_indices.update(indices)
    
    print(f"\nTotal unique emails across all datasets: {len(all_indices)}")
    print("Dataset generation complete!")

if __name__ == "__main__":
    main()